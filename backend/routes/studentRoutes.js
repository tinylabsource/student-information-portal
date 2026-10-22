const express = require("express");
const router = express.Router();

let students = require("../data/students");

let nextId = Math.max(0, ...students.map(student => student.id)) + 1;

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

// Find a student by ID
const findStudent = id =>
  students.find(student => student.id === Number(id));

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

// Check for duplicate student IDs
function hasDuplicateStudentId(studentId, excludeId = null) {
  return students.some(student =>
    student.id !== excludeId &&
    student.studentId.toLowerCase() === studentId.toLowerCase()
  );
}

// GET: List and search students
router.get("/", (req, res) => {
  const search = String(req.query.search || "").trim().toLowerCase();

  const result = students.filter(student =>
    [
      student.studentId,
      student.firstName,
      student.lastName,
      student.email,
      student.course
    ].some(value => value.toLowerCase().includes(search))
  );

  res.json({
    success: true,
    count: result.length,
    data: result
  });
});

// GET: Get one student
router.get("/:id", (req, res) => {
  const student = findStudent(req.params.id);

  if (!student) {
    return res.status(404).json({
      success: false,
      message: "Student not found"
    });
  }

  res.json({ success: true, data: student });
});

// POST: Add a student
router.post("/", (req, res) => {
  const error = validateStudent(req.body);

  if (error) {
    return res.status(400).json({
      success: false,
      message: error
    });
  }

  const data = {
    ...req.body,
    studentId: req.body.studentId.trim(),
    firstName: req.body.firstName.trim(),
    lastName: req.body.lastName.trim(),
    email: req.body.email.trim(),
    course: req.body.course.trim(),
    yearLevel: Number(req.body.yearLevel)
  };

  if (hasDuplicateStudentId(data.studentId)) {
    return res.status(409).json({
      success: false,
      message: "Student ID already exists"
    });
  }

  const student = { id: nextId++, ...data };

  students.push(student);

  res.status(201).json({
    success: true,
    message: "Student added successfully",
    data: student
  });
});

// PUT: Update a student
router.put("/:id", (req, res) => {
  const student = findStudent(req.params.id);

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

  const updated = { ...student, ...req.body };
  const error = validateStudent(updated);

  if (error) {
    return res.status(400).json({
      success: false,
      message: error
    });
  }

  updated.studentId = updated.studentId.trim();
  updated.firstName = updated.firstName.trim();
  updated.lastName = updated.lastName.trim();
  updated.email = updated.email.trim();
  updated.course = updated.course.trim();
  updated.yearLevel = Number(updated.yearLevel);

  if (hasDuplicateStudentId(updated.studentId, student.id)) {
    return res.status(409).json({
      success: false,
      message: "Student ID already exists"
    });
  }

  students = students.map(item =>
    item.id === student.id ? updated : item
  );

  res.json({
    success: true,
    message: "Student updated successfully",
    data: updated
  });
});

// DELETE: Remove a student
router.delete("/:id", (req, res) => {
  const student = findStudent(req.params.id);

  if (!student) {
    return res.status(404).json({
      success: false,
      message: "Student not found"
    });
  }

  students = students.filter(item => item.id !== student.id);

  res.json({
    success: true,
    message: "Student deleted successfully"
  });
});

module.exports = router;