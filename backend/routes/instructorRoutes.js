const express = require("express");
const router = express.Router();

const { getDb, nextId, loginIdTaken } = require("../db");
const { textField } = require("../validators");

// Hide MongoDB's internal _id from API responses
const hideMongoId = { projection: { _id: 0 } };

const fields = {
  instructorId: ["Instructor ID", textField({ max: 40 })],
  firstName: ["First name", textField({ max: 80 })],
  lastName: ["Last name", textField({ max: 80 })],
  email: ["Email", textField({ max: 120 })]
};

// Validate and normalize instructor data: { instructor } or { error }
function validateInstructor(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object" };
  }

  try {
    const instructor = {};

    for (const [key, [label, validate]] of Object.entries(fields)) {
      instructor[key] = validate(data[key], label);
    }

    return { instructor };
  } catch (message) {
    return { error: message };
  }
}

const notFound = res =>
  res.status(404).json({
    success: false,
    message: "Instructor not found"
  });

const duplicateResponse = res =>
  res.status(409).json({
    success: false,
    message: "Instructor ID already exists (or is used by a student)"
  });

const isDuplicateKeyError = err => err && err.code === 11000;

// GET: List instructors, with how many classes each one teaches
router.get("/", async (req, res) => {
  const db = await getDb();
  const instructors = await db.collection("instructors")
    .find({}, hideMongoId)
    .sort({ id: 1 })
    .toArray();

  const classes = await db.collection("classes")
    .find({}, { projection: { _id: 0, instructorRef: 1 } })
    .toArray();

  const data = instructors.map(instructor => ({
    ...instructor,
    classCount: classes.filter(c => c.instructorRef === instructor.id).length
  }));

  res.json({ success: true, count: data.length, data });
});

// POST: Add an instructor
router.post("/", async (req, res) => {
  const { instructor, error } = validateInstructor(req.body);

  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const db = await getDb();

  if (await loginIdTaken(db, instructor.instructorId)) {
    return duplicateResponse(res);
  }

  const created = { id: await nextId(db, "instructors"), ...instructor };

  try {
    await db.collection("instructors").insertOne({ ...created });
  } catch (err) {
    if (isDuplicateKeyError(err)) return duplicateResponse(res);
    throw err;
  }

  res.status(201).json({
    success: true,
    message: "Instructor added successfully",
    data: created
  });
});

// PUT: Update an instructor
router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const db = await getDb();

  if (!(await db.collection("instructors").findOne({ id }))) return notFound(res);

  const { instructor, error } = validateInstructor(req.body);

  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  if (await loginIdTaken(db, instructor.instructorId, { collection: "instructors", id })) {
    return duplicateResponse(res);
  }

  const updated = { id, ...instructor };

  try {
    await db.collection("instructors").replaceOne({ id }, { ...updated });
  } catch (err) {
    if (isDuplicateKeyError(err)) return duplicateResponse(res);
    throw err;
  }

  res.json({
    success: true,
    message: "Instructor updated successfully",
    data: updated
  });
});

// DELETE: Remove an instructor who no longer teaches any class
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const db = await getDb();

  if (!(await db.collection("instructors").findOne({ id }))) return notFound(res);

  const teaching = await db.collection("classes").countDocuments(
    { instructorRef: id },
    { limit: 1 }
  );

  if (teaching > 0) {
    return res.status(409).json({
      success: false,
      message: "This instructor still has classes. Reassign or delete those classes first."
    });
  }

  await db.collection("instructors").deleteOne({ id });
  await db.collection("instructorAccounts").deleteOne({ instructorRef: id });

  res.json({
    success: true,
    message: "Instructor deleted successfully"
  });
});

// POST: Reset an instructor's password back to the default (their surname)
router.post("/:id/reset-password", async (req, res) => {
  const id = Number(req.params.id);
  const db = await getDb();

  if (!(await db.collection("instructors").findOne({ id }))) return notFound(res);

  await db.collection("instructorAccounts").deleteOne({ instructorRef: id });

  res.json({
    success: true,
    message: "Password reset to the instructor's surname"
  });
});

module.exports = router;
