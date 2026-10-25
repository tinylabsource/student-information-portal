const { MongoClient } = require("mongodb");
const sampleStudents = require("./data/students");

const DB_NAME = process.env.MONGODB_DB || "student_portal";

// Case-insensitive comparison for student IDs
const caseInsensitive = { locale: "en", strength: 2 };

// Reuse one connection across requests (and across warm Vercel invocations)
let dbPromise = null;

async function connect() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("MONGODB_URI is not set");
  }

  const client = new MongoClient(uri);
  await client.connect();

  const db = client.db(DB_NAME);
  const students = db.collection("students");

  await students.createIndex({ id: 1 }, { unique: true });
  await students.createIndex(
    { studentId: 1 },
    { unique: true, collation: caseInsensitive }
  );

  // Changed passwords, one per student (links to students.id)
  await db.collection("accounts").createIndex({ studentRef: 1 }, { unique: true });

  // Grades, schedule, and tuition, one per student (links to students.id)
  await db.collection("records").createIndex({ studentRef: 1 }, { unique: true });

  // First run: fill an empty database with the sample students
  if ((await students.countDocuments()) === 0) {
    await students.insertMany(sampleStudents.map(student => ({ ...student })));
    await db.collection("counters").updateOne(
      { _id: "students" },
      { $max: { seq: Math.max(0, ...sampleStudents.map(s => s.id)) } },
      { upsert: true }
    );
  }

  return db;
}

function getDb() {
  if (!dbPromise) {
    dbPromise = connect().catch(err => {
      dbPromise = null; // retry on the next request
      throw err;
    });
  }

  return dbPromise;
}

// Next numeric ID, so the frontend keeps working with number IDs
async function nextStudentId(db) {
  const counter = await db.collection("counters").findOneAndUpdate(
    { _id: "students" },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );

  return counter.seq;
}

module.exports = { getDb, nextStudentId, caseInsensitive };
