const express = require("express");
const router = express.Router();

const { getDb, caseInsensitive } = require("../db");
const {
  hashPassword,
  verifyPassword,
  safeEqual,
  createToken,
  requireAuth
} = require("../auth");

const ADMIN_USERNAME = "admin";
const MIN_PASSWORD_LENGTH = 8;

// People who log in with an ID number. Their default password is their
// surname until they change it (no account document yet).
const ROLES = {
  student: {
    people: "students",
    loginField: "studentId",
    accounts: "accounts",
    ref: "studentRef"
  },
  instructor: {
    people: "instructors",
    loginField: "instructorId",
    accounts: "instructorAccounts",
    ref: "instructorRef"
  }
};

// Hide MongoDB's internal _id from API responses
const hideMongoId = { projection: { _id: 0 } };

// Find who a login ID belongs to: { role, person } or null
async function findByLoginId(loginId) {
  const db = await getDb();

  for (const [role, config] of Object.entries(ROLES)) {
    const person = await db.collection(config.people).findOne(
      { [config.loginField]: loginId },
      { ...hideMongoId, collation: caseInsensitive }
    );

    if (person) return { role, person };
  }

  return null;
}

async function findPerson(role, id) {
  const db = await getDb();
  return db.collection(ROLES[role].people).findOne({ id }, hideMongoId);
}

async function findAccount(role, person) {
  const db = await getDb();
  const { accounts, ref } = ROLES[role];
  return db.collection(accounts).findOne({ [ref]: person.id });
}

// The default password is the person's surname (case-insensitive)
const isDefaultPassword = (password, person) =>
  password.trim().toLowerCase() === person.lastName.trim().toLowerCase();

const passwordMatches = async (password, person, account) =>
  account
    ? verifyPassword(password, account.passwordHash)
    : isDefaultPassword(password, person);

const invalidLogin = res =>
  res.status(401).json({
    success: false,
    message: "Invalid ID or password"
  });

const accountGone = res =>
  res.status(401).json({
    success: false,
    message: "Account no longer exists"
  });

function sessionResponse(res, user, profile = null) {
  res.json({
    success: true,
    token: createToken(user),
    user: { ...user, profile }
  });
}

// POST: Log in as a student or instructor (ID + password) or as the admin
router.post("/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: "ID and password are required"
    });
  }

  if (username.toLowerCase() === ADMIN_USERNAME) {
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword || !safeEqual(password, adminPassword)) {
      return invalidLogin(res);
    }

    return sessionResponse(res, { role: "admin" });
  }

  const found = await findByLoginId(username);
  if (!found) return invalidLogin(res);

  const { role, person } = found;
  const account = await findAccount(role, person);

  if (!(await passwordMatches(password, person, account))) {
    return invalidLogin(res);
  }

  sessionResponse(
    res,
    { role, id: person.id, mustChangePassword: !account },
    person
  );
});

// GET: The logged-in user (and their student or instructor profile)
router.get(
  "/me",
  requireAuth({ allowPasswordChange: true }),
  async (req, res) => {
    const { role, id } = req.user;

    if (role === "admin") {
      return res.json({ success: true, user: { role, profile: null } });
    }

    const person = await findPerson(role, id);
    if (!person) return accountGone(res);

    res.json({
      success: true,
      user: {
        role,
        id,
        mustChangePassword: Boolean(req.user.mustChangePassword),
        profile: person
      }
    });
  }
);

// POST: Change the logged-in student's or instructor's password
router.post(
  "/change-password",
  requireAuth({ roles: Object.keys(ROLES), allowPasswordChange: true }),
  async (req, res) => {
    const { role, id } = req.user;
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");

    const person = await findPerson(role, id);
    if (!person) return accountGone(res);

    const account = await findAccount(role, person);

    if (!(await passwordMatches(currentPassword, person, account))) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect"
      });
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`
      });
    }

    if (isDefaultPassword(newPassword, person) || newPassword === currentPassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from your current password"
      });
    }

    const { accounts, ref } = ROLES[role];
    const db = await getDb();

    await db.collection(accounts).updateOne(
      { [ref]: id },
      {
        $set: {
          passwordHash: await hashPassword(newPassword),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    sessionResponse(res, { role, id, mustChangePassword: false }, person);
  }
);

module.exports = router;
