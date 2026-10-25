const express = require("express");
const router = express.Router();

const { getDb } = require("../db");
const { requireAuth } = require("../auth");
const {
  textField,
  numberField,
  timeField,
  dateField,
  gradeField
} = require("../validators");

const MAX_ROWS = 200;

// SECTIONS: the lists kept for each student, field by field
const sections = {
  grades: {
    fields: {
      term: ["Term", textField({ max: 60 })],
      code: ["Subject code", textField({ max: 30 })],
      title: ["Subject", textField()],
      units: ["Units", numberField({ max: 12, decimals: 1 })],
      grade: ["Grade", gradeField]
    }
  },
  schedule: {
    fields: {
      code: ["Subject code", textField({ max: 30 })],
      title: ["Subject", textField()],
      days: ["Days", textField({ max: 30 })],
      startTime: ["Start time", timeField],
      endTime: ["End time", timeField],
      room: ["Room", textField({ required: false, max: 50 })],
      instructor: ["Instructor", textField({ required: false, max: 80 })]
    },
    check: row => {
      if (row.endTime <= row.startTime) throw "End time must be after start time";
    }
  },
  fees: {
    fields: {
      description: ["Description", textField()],
      amount: ["Amount", numberField({ max: 10000000 })]
    }
  },
  payments: {
    fields: {
      date: ["Date", dateField],
      reference: ["Reference / OR no.", textField({ required: false, max: 50 })],
      amount: ["Amount", numberField({ min: 0.01, max: 10000000 })]
    }
  }
};

// Validate a list of rows; returns { rows } or { error }
function validateRows(section, rows) {
  if (!Array.isArray(rows)) return { error: "rows must be a list" };
  if (rows.length > MAX_ROWS) return { error: `At most ${MAX_ROWS} rows allowed` };

  const { fields, check } = sections[section];
  const clean = [];

  for (const [index, row] of rows.entries()) {
    try {
      if (!row || typeof row !== "object") throw "Invalid row";

      const cleanRow = {};

      for (const [key, [label, validate]] of Object.entries(fields)) {
        cleanRow[key] = validate(row[key], label);
      }

      if (check) check(cleanRow);
      clean.push(cleanRow);
    } catch (message) {
      return { error: `Row ${index + 1}: ${message}` };
    }
  }

  return { rows: clean };
}

const emptyRecord = () =>
  Object.fromEntries(Object.keys(sections).map(section => [section, []]));

async function getRecord(studentRef) {
  const db = await getDb();
  const record = await db.collection("records").findOne(
    { studentRef },
    { projection: { _id: 0, studentRef: 0, updatedAt: 0 } }
  );

  // Grades given by instructors in the student's classes (read-only here;
  // the `grades` section holds grades the admin entered by hand)
  const classes = await db.collection("classes")
    .find({ students: studentRef }, { projection: { _id: 0 } })
    .sort({ id: 1 })
    .toArray();

  const instructors = await db.collection("instructors")
    .find({ id: { $in: classes.map(c => c.instructorRef) } }, { projection: { _id: 0 } })
    .toArray();

  const classGrades = classes.map(c => {
    const instructor = instructors.find(i => i.id === c.instructorRef);

    return {
      term: c.term,
      code: c.code,
      title: c.title,
      units: c.units,
      grade: c.grades?.[studentRef] || "",
      instructor: instructor ? `${instructor.firstName} ${instructor.lastName}` : ""
    };
  });

  // Weekly schedules of the student's classes (the `schedule` section holds
  // entries the admin added by hand)
  const classSchedule = classes
    .filter(c => c.days && c.startTime && c.endTime)
    .map(c => {
      const instructor = instructors.find(i => i.id === c.instructorRef);

      return {
        code: c.code,
        title: c.title,
        days: c.days,
        startTime: c.startTime,
        endTime: c.endTime,
        room: c.room || "",
        instructor: instructor ? `${instructor.firstName} ${instructor.lastName}` : ""
      };
    });

  return { ...emptyRecord(), ...record, classGrades, classSchedule };
}

async function studentExists(id) {
  const db = await getDb();
  return (await db.collection("students").countDocuments({ id }, { limit: 1 })) > 0;
}

const notFound = res =>
  res.status(404).json({
    success: false,
    message: "Student not found"
  });

// GET: The logged-in student's own grades, schedule, and tuition
router.get("/me", requireAuth({ roles: ["student"] }), async (req, res) => {
  res.json({ success: true, data: await getRecord(req.user.id) });
});

// GET: Any student's record (admin)
router.get("/:id", requireAuth({ roles: ["admin"] }), async (req, res) => {
  const id = Number(req.params.id);

  if (!(await studentExists(id))) return notFound(res);

  res.json({ success: true, data: await getRecord(id) });
});

// PUT: Replace one section (grades, schedule, fees, payments) of a record (admin)
router.put("/:id/:section", requireAuth({ roles: ["admin"] }), async (req, res) => {
  const id = Number(req.params.id);
  const { section } = req.params;

  if (!Object.hasOwn(sections, section)) {
    return res.status(404).json({
      success: false,
      message: "Unknown record section"
    });
  }

  if (!(await studentExists(id))) return notFound(res);

  const { rows, error } = validateRows(section, req.body?.rows);

  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const db = await getDb();

  await db.collection("records").updateOne(
    { studentRef: id },
    { $set: { [section]: rows, updatedAt: new Date() } },
    { upsert: true }
  );

  res.json({
    success: true,
    message: "Record updated successfully",
    data: rows
  });
});

module.exports = router;
