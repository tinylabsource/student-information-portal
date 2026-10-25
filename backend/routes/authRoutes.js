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

// Hide MongoDB's internal _id from API responses
const hideMongoId = { projection: { _id: 0 } };

const collections = async () => {
  const db = await getDb();
  return {
    students: db.collection("students"),
    accounts: db.collection("accounts")
  };
};

// The default password is the student's surname (case-insensitive)
const isDefaultPassword = (password, student) =>
  password.trim().toLowerCase() === student.lastName.trim().toLowerCase();

const invalidLogin = res =>
  res.status(401).json({
    success: false,
    message: "Invalid student ID or password"
  });

function sessionResponse(res, user, student = null) {
  res.json({
    success: true,
    token: createToken(user),
    user: { ...user, student }
  });
}

// POST: Log in as a student (student ID + password) or as the admin
router.post("/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: "Student ID and password are required"
    });
  }

  if (username.toLowerCase() === ADMIN_USERNAME) {
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword || !safeEqual(password, adminPassword)) {
      return invalidLogin(res);
    }

    return sessionResponse(res, { role: "admin" });
  }

  const { students, accounts } = await collections();
  const student = await students.findOne(
    { studentId: username },
    { ...hideMongoId, collation: caseInsensitive }
  );

  if (!student) return invalidLogin(res);

  // No account yet means the student has never changed the default password
  const account = await accounts.findOne({ studentRef: student.id });

  const valid = account
    ? await verifyPassword(password, account.passwordHash)
    : isDefaultPassword(password, student);

  if (!valid) return invalidLogin(res);

  sessionResponse(
    res,
    { role: "student", id: student.id, mustChangePassword: !account },
    student
  );
});

// GET: The logged-in user (and their student record)
router.get(
  "/me",
  requireAuth({ allowPasswordChange: true }),
  async (req, res) => {
    if (req.user.role === "admin") {
      return res.json({ success: true, user: { role: "admin", student: null } });
    }

    const { students } = await collections();
    const student = await students.findOne({ id: req.user.id }, hideMongoId);

    if (!student) {
      return res.status(401).json({
        success: false,
        message: "Student account no longer exists"
      });
    }

    res.json({
      success: true,
      user: {
        role: "student",
        id: student.id,
        mustChangePassword: Boolean(req.user.mustChangePassword),
        student
      }
    });
  }
);

// POST: Change the logged-in student's password
router.post(
  "/change-password",
  requireAuth({ roles: ["student"], allowPasswordChange: true }),
  async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");

    const { students, accounts } = await collections();
    const student = await students.findOne({ id: req.user.id }, hideMongoId);

    if (!student) {
      return res.status(401).json({
        success: false,
        message: "Student account no longer exists"
      });
    }

    const account = await accounts.findOne({ studentRef: student.id });

    const currentValid = account
      ? await verifyPassword(currentPassword, account.passwordHash)
      : isDefaultPassword(currentPassword, student);

    if (!currentValid) {
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

    if (isDefaultPassword(newPassword, student) || newPassword === currentPassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from your current password"
      });
    }

    await accounts.updateOne(
      { studentRef: student.id },
      {
        $set: {
          passwordHash: await hashPassword(newPassword),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    sessionResponse(
      res,
      { role: "student", id: student.id, mustChangePassword: false },
      student
    );
  }
);

module.exports = router;
