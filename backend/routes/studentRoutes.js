const express = require("express");
const router = express.Router();

const { getDb, nextStudentId, caseInsensitive } = require("../db");

const fields = [
  "studentId",
  "firstName",
  "lastName",
  "email",
  "course",
  "yearLevel"
];

const textFields = [
  "studentId",
  "firstName",
  "lastName",
  "email",
  "course"
];

// Hide MongoDB's internal _id from API responses
const hideMongoId = { projection: { _id: 0 } };

const studentsCollection = async () =>
  (await getDb()).collection("students");

// Find a student by ID
async function findStudent(id) {
  const students = await studentsCollection();
  return students.findOne({ id: Number(id) }, hideMongoId);
}

// Validate and normalize student data
function validateStudent(data) {
  for (const field of textFields) {
    if (typeof data[field] !== "string" || !data[field].trim()) {
      return `${field} is required`;
    }
  }

  const yearLevel = Number(data.yearLevel);

  if (
    data.yearLevel === "" ||
    data.yearLevel === null ||
    data.yearLevel === undefined ||
    !Number.isInteger(yearLevel) ||
    yearLevel < 1 ||
    yearLevel > 6
  ) {
    return "Year level must be an integer from 1 to 6";
  }

  return null;
}

// Keep only known fields, trimmed and typed
function normalizeStudent(data) {
  return {
    studentId: data.studentId.trim(),
    firstName: data.firstName.trim(),
    lastName: data.lastName.trim(),
    email: data.email.trim(),
    course: data.course.trim(),
    yearLevel: Number(data.yearLevel)
  };
}

// Check for duplicate student IDs (case-insensitive)
async function hasDuplicateStudentId(studentId, excludeId = null) {
  const students = await studentsCollection();
  const query = { studentId };

  if (excludeId !== null) query.id = { $ne: excludeId };

  const count = await students.countDocuments(query, {
    collation: caseInsensitive,
    limit: 1
  });

  return count > 0;
}

const isDuplicateKeyError = err => err && err.code === 11000;

const duplicateResponse = res =>
  res.status(409).json({
    success: false,
    message: "Student ID already exists"
  });

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// GET: List and search students
router.get("/", async (req, res) => {
  const search = String(req.query.search || "").trim();
  const students = await studentsCollection();

  const query = search
    ? {
        $or: textFields.map(field => ({
          [field]: { $regex: escapeRegex(search), $options: "i" }
        }))
      }
    : {};

  const result = await students
    .find(query, hideMongoId)
    .sort({ id: 1 })
    .toArray();

  res.json({
    success: true,
    count: result.length,
    data: result
  });
});

// GET: Get one student
router.get("/:id", async (req, res) => {
  const student = await findStudent(req.params.id);

  if (!student) {
    return res.status(404).json({
      success: false,
      message: "Student not found"
    });
  }

  res.json({ success: true, data: student });
});

// POST: Add a student
router.post("/", async (req, res) => {
  const error = validateStudent(req.body || {});

  if (error) {
    return res.status(400).json({
      success: false,
      message: error
    });
  }

  const data = normalizeStudent(req.body);

  if (await hasDuplicateStudentId(data.studentId)) {
    return duplicateResponse(res);
  }

  const db = await getDb();
  const student = { id: await nextStudentId(db), ...data };

  try {
    await db.collection("students").insertOne({ ...student });
  } catch (err) {
    if (isDuplicateKeyError(err)) return duplicateResponse(res);
    throw err;
  }

  res.status(201).json({
    success: true,
    message: "Student added successfully",
    data: student
  });
});

// PUT: Update a student
router.put("/:id", async (req, res) => {
  const student = await findStudent(req.params.id);

  if (!student) {
    return res.status(404).json({
      success: false,
      message: "Student not found"
    });
  }

  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body)
  ) {
    return res.status(400).json({
      success: false,
      message: "Request body must be a JSON object"
    });
  }

  if (Object.keys(req.body).some(field => !fields.includes(field))) {
    return res.status(400).json({
      success: false,
      message: "Request contains unsupported fields"
    });
  }

  const merged = { ...student, ...req.body };
  const error = validateStudent(merged);

  if (error) {
    return res.status(400).json({
      success: false,
      message: error
    });
  }

  const updated = { id: student.id, ...normalizeStudent(merged) };

  if (await hasDuplicateStudentId(updated.studentId, student.id)) {
    return duplicateResponse(res);
  }

  const students = await studentsCollection();

  try {
    await students.replaceOne({ id: student.id }, { ...updated });
  } catch (err) {
    if (isDuplicateKeyError(err)) return duplicateResponse(res);
    throw err;
  }

  res.json({
    success: true,
    message: "Student updated successfully",
    data: updated
  });
});

// DELETE: Remove a student
router.delete("/:id", async (req, res) => {
  const students = await studentsCollection();
  const id = Number(req.params.id);
  const result = await students.deleteOne({ id });

  if (result.deletedCount === 0) {
    return res.status(404).json({
      success: false,
      message: "Student not found"
    });
  }

  // Remove the deleted student's login and records too
  const db = await getDb();
  await db.collection("accounts").deleteOne({ studentRef: id });
  await db.collection("records").deleteOne({ studentRef: id });

  res.json({
    success: true,
    message: "Student deleted successfully"
  });
});

// POST: Reset a student's password back to the default (their surname)
router.post("/:id/reset-password", async (req, res) => {
  const student = await findStudent(req.params.id);

  if (!student) {
    return res.status(404).json({
      success: false,
      message: "Student not found"
    });
  }

  await (await getDb()).collection("accounts").deleteOne({ studentRef: student.id });

  res.json({
    success: true,
    message: "Password reset to the student's surname"
  });
});

module.exports = router;
