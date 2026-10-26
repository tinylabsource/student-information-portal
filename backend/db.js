const dns = require("dns");
const { MongoClient } = require("mongodb");
const sampleStudents = require("./data/students");

// On some Windows networks Node only gets 127.0.0.1 as its DNS server and
// cannot look up the mongodb+srv:// address; use public DNS instead then.
const LOOPBACK_DNS = ["127.0.0.1", "::1"];
if (process.platform === "win32" && dns.getServers().every(s => LOOPBACK_DNS.includes(s))) {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
}

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

  // Instructors log in with instructorId, like students with studentId
  const instructors = db.collection("instructors");
  await instructors.createIndex({ id: 1 }, { unique: true });
  await instructors.createIndex(
    { instructorId: 1 },
    { unique: true, collation: caseInsensitive }
  );
  await db.collection("instructorAccounts").createIndex(
    { instructorRef: 1 },
    { unique: true }
  );

  // Classes: one subject, one instructor, enrolled students and their grades
  const classes = db.collection("classes");
  await classes.createIndex({ id: 1 }, { unique: true });
  await classes.createIndex({ instructorRef: 1 });
  await classes.createIndex({ students: 1 });

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

// Next numeric ID for a collection, so the frontend works with number IDs
async function nextId(db, name) {
  const counter = await db.collection("counters").findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );

  return counter.seq;
}

const nextStudentId = db => nextId(db, "students");

// Students and instructors share one login box, so a login ID
// (studentId / instructorId) may only be used once across both.
// `except` skips the record being updated: { collection, id }.
async function loginIdTaken(db, loginId, except = {}) {
  const lookups = [
    ["students", "studentId"],
    ["instructors", "instructorId"]
  ];

  for (const [collection, field] of lookups) {
    const query = { [field]: loginId };
    if (except.collection === collection) query.id = { $ne: except.id };

    const count = await db.collection(collection).countDocuments(query, {
      collation: caseInsensitive,
      limit: 1
    });

    if (count > 0) return true;
  }

  return false;
}

module.exports = { getDb, nextId, nextStudentId, loginIdTaken, caseInsensitive };
