const express = require("express");
const router = express.Router();

const { getDb, nextId } = require("../db");
const { requireAuth } = require("../auth");
const { textField, numberField, gradeField } = require("../validators");

const adminOnly = requireAuth({ roles: ["admin"] });
const MAX_STUDENTS = 500;

// Hide MongoDB's internal _id from API responses
const hideMongoId = { projection: { _id: 0 } };

const fields = {
  term: ["Term", textField({ max: 60 })],
  code: ["Subject code", textField({ max: 30 })],
  title: ["Subject", textField()],
  units: ["Units", numberField({ max: 12, decimals: 1 })]
};

const classesCollection = async () => (await getDb()).collection("classes");

const fullName = person => person ? `${person.firstName} ${person.lastName}` : "";

// Validate class details: { details } or { error }
async function validateClass(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object" };
  }

  try {
    const details = {};

    for (const [key, [label, validate]] of Object.entries(fields)) {
      details[key] = validate(data[key], label);
    }

    details.instructorRef = Number(data.instructorRef);
    const db = await getDb();

    if (!(await db.collection("instructors").findOne({ id: details.instructorRef }))) {
      throw "Choose an instructor for this class";
    }

    return { details };
  } catch (message) {
    return { error: message };
  }
}

// Load a class the user may access: admins see all, instructors their own.
// Sends the error response and returns null when not allowed.
async function loadClass(req, res) {
  const classes = await classesCollection();
  const found = await classes.findOne({ id: Number(req.params.id) }, hideMongoId);

  if (!found || (req.user.role === "instructor" && found.instructorRef !== req.user.id)) {
    res.status(404).json({ success: false, message: "Class not found" });
    return null;
  }

  return found;
}

// A class with its instructor's name and its students (with grades)
async function classDetails(found) {
  const db = await getDb();
  const instructor = await db.collection("instructors").findOne({ id: found.instructorRef });
  const enrolled = await db.collection("students")
    .find({ id: { $in: found.students } }, hideMongoId)
    .toArray();

  const roster = enrolled
    .map(student => ({
      id: student.id,
      studentId: student.studentId,
      firstName: student.firstName,
      lastName: student.lastName,
      course: student.course,
      yearLevel: student.yearLevel,
      grade: found.grades?.[student.id] || ""
    }))
    .sort((a, b) =>
      `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));

  const { grades, students, ...details } = found;

  return { ...details, instructorName: fullName(instructor), roster };
}

// GET: List classes (all for the admin, own classes for an instructor)
router.get("/", requireAuth({ roles: ["admin", "instructor"] }), async (req, res) => {
  const db = await getDb();
  const query = req.user.role === "instructor" ? { instructorRef: req.user.id } : {};

  const classes = await db.collection("classes")
    .find(query, hideMongoId)
    .sort({ id: 1 })
    .toArray();

  const instructors = await db.collection("instructors")
    .find({}, hideMongoId)
    .toArray();

  const data = classes.map(({ grades, students, ...details }) => ({
    ...details,
    instructorName: fullName(instructors.find(i => i.id === details.instructorRef)),
    studentCount: students.length,
    gradedCount: students.filter(id => grades?.[id]).length
  }));

  res.json({ success: true, count: data.length, data });
});

// GET: One class with its class list and grades
router.get("/:id", requireAuth({ roles: ["admin", "instructor"] }), async (req, res) => {
  const found = await loadClass(req, res);
  if (!found) return;

  res.json({ success: true, data: await classDetails(found) });
});

// POST: Create a class (admin)
router.post("/", adminOnly, async (req, res) => {
  const { details, error } = await validateClass(req.body);

  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const db = await getDb();
  const created = {
    id: await nextId(db, "classes"),
    ...details,
    students: [],
    grades: {}
  };

  await db.collection("classes").insertOne({ ...created });

  res.status(201).json({
    success: true,
    message: "Class created successfully",
    data: await classDetails(created)
  });
});

// PUT: Update a class's details or instructor (admin)
router.put("/:id", adminOnly, async (req, res) => {
  const found = await loadClass(req, res);
  if (!found) return;

  const { details, error } = await validateClass(req.body);

  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const classes = await classesCollection();
  await classes.updateOne({ id: found.id }, { $set: details });

  res.json({
    success: true,
    message: "Class updated successfully",
    data: await classDetails({ ...found, ...details })
  });
});

// DELETE: Remove a class and the grades given in it (admin)
router.delete("/:id", adminOnly, async (req, res) => {
  const found = await loadClass(req, res);
  if (!found) return;

  const classes = await classesCollection();
  await classes.deleteOne({ id: found.id });

  res.json({
    success: true,
    message: "Class deleted successfully"
  });
});

// PUT: Set which students are enrolled in a class (admin)
router.put("/:id/students", adminOnly, async (req, res) => {
  const found = await loadClass(req, res);
  if (!found) return;

  const list = req.body?.students;

  if (!Array.isArray(list) || list.length > MAX_STUDENTS) {
    return res.status(400).json({
      success: false,
      message: `students must be a list of at most ${MAX_STUDENTS} student IDs`
    });
  }

  const ids = [...new Set(list.map(Number))];
  const db = await getDb();
  const existing = await db.collection("students").countDocuments({ id: { $in: ids } });

  if (ids.some(id => !Number.isInteger(id)) || existing !== ids.length) {
    return res.status(400).json({
      success: false,
      message: "Some of those students do not exist"
    });
  }

  // Keep grades only for students who are still enrolled
  const grades = Object.fromEntries(
    ids.filter(id => found.grades?.[id]).map(id => [id, found.grades[id]])
  );

  const classes = await classesCollection();
  await classes.updateOne({ id: found.id }, { $set: { students: ids, grades } });

  res.json({
    success: true,
    message: "Class list updated",
    data: await classDetails({ ...found, students: ids, grades })
  });
});

// PUT: Give grades to enrolled students (admin or the class's instructor)
// Body: { grades: { "<student id>": "1.50" | "INC" | "DRP" | "" } }
router.put(
  "/:id/grades",
  requireAuth({ roles: ["admin", "instructor"] }),
  async (req, res) => {
    const found = await loadClass(req, res);
    if (!found) return;

    const given = req.body?.grades;

    if (!given || typeof given !== "object" || Array.isArray(given)) {
      return res.status(400).json({
        success: false,
        message: "grades must be an object of student ID to grade"
      });
    }

    const grades = { ...found.grades };

    for (const [key, value] of Object.entries(given)) {
      const id = Number(key);

      if (!found.students.includes(id)) {
        return res.status(400).json({
          success: false,
          message: "A student in that list is not enrolled in this class"
        });
      }

      try {
        const grade = gradeField(value, "Grade");
        if (grade) grades[id] = grade;
        else delete grades[id];
      } catch (message) {
        return res.status(400).json({ success: false, message });
      }
    }

    const classes = await classesCollection();
    await classes.updateOne(
      { id: found.id },
      { $set: { grades, gradesUpdatedAt: new Date() } }
    );

    res.json({
      success: true,
      message: "Grades saved",
      data: await classDetails({ ...found, grades })
    });
  }
);

module.exports = router;
