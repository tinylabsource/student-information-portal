const express = require("express");
const router = express.Router();

const { requireAuth } = require("../auth");

// Ollama server and the model it should use. With an OLLAMA_API_KEY the
// chatbot uses Ollama Cloud (needed on Vercel); without one, local Ollama.
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
const USE_CLOUD = Boolean(OLLAMA_API_KEY);

const OLLAMA_URL = (
  process.env.OLLAMA_URL || (USE_CLOUD ? "https://ollama.com" : "http://localhost:11434")
).replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || (USE_CLOUD ? "gpt-oss:20b" : "llama3.2:1b");

const MAX_MESSAGES = 10; // only the latest turns are sent to the model
const MAX_LENGTH = 2000; // characters per message
const TIMEOUT_MS = 60 * 1000;

// What each role can do in the portal, using the real button and tab names,
// so the bot answers for that user instead of inventing menus
const ROLE_GUIDES = {
  student: `The user is a STUDENT. Their screen is "My Profile" with these tabs:
- Grades: subject grades and remarks (1.0 to 3.0 = Passed, 5.0 = Failed).
- Schedule: class days, times and rooms.
- Tuition: Total Assessment, Total Paid and Remaining Balance, plus fees and payments.
- Change Password button: enter Current Password, New Password and Confirm New Password.
Students cannot edit their own records. For wrong grades or fees, they ask their instructor or the admin.
A forgotten password can only be reset by the admin (it goes back to the surname).`,
  instructor: `The user is an INSTRUCTOR. Their screen is "My Classes".
- To grade: click a class, choose a grade for each student in "Class List & Grades", then click "Save Grades".
- 1.0 to 3.0 = Passed, 5.0 = Failed.
- Change Password button changes their own password.
Instructors cannot add classes or enroll students; the admin does that.`,
  admin: `The user is the ADMIN. The sidebar has Students, Instructors and Classes.
- Students tab: "+ Add Student" adds one. Each row has View (open their grades, schedule and tuition to edit them), Edit, "Reset PW" (resets the password to the student's surname) and ✕ (delete).
- Instructors tab: "+ Add Instructor"; each row has Edit, "Reset PW" and delete.
- Classes tab: "+ Add Class" sets subject, term, units, room, days, start and end time, and instructor. Open a class and use "+ Enroll Student" to add students.
There is no email or "Forgot Password" feature.`
};

function systemPrompt(role) {
  return [
    "You are the help assistant of the Student Information Portal, a school web app.",
    "Only describe features listed below. Never invent buttons, menus or emails; if you are not sure, say so and suggest asking the admin.",
    "Answer questions about how to use the portal, briefly and clearly, in simple language.",
    "Students and instructors log in with their ID number; their first password is their " +
      "surname, and they must change it on first login.",
    ROLE_GUIDES[role] || "",
    "You cannot see or change any records. If asked for someone's actual grades, " +
      "balance or other data, tell the user where to find it in the portal instead.",
    "If a question is not about the portal or school life, say politely that you can " +
      "only help with the Student Information Portal."
  ].join("\n");
}

// Keep only well-formed user/assistant turns from the browser
function cleanMessages(messages) {
  if (!Array.isArray(messages)) throw "Messages must be a list";

  const cleaned = messages
    .filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, MAX_LENGTH) }))
    .filter(m => m.content)
    .slice(-MAX_MESSAGES);

  if (cleaned.at(-1)?.role !== "user") throw "Type a question first";
  return cleaned;
}

// Ask the chatbot a question (any logged-in user)
router.post("/", requireAuth(), async (req, res, next) => {
  let messages;

  try {
    messages = cleanMessages(req.body?.messages);
  } catch (message) {
    return res.status(400).json({ success: false, message });
  }

  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(OLLAMA_API_KEY && { Authorization: `Bearer ${OLLAMA_API_KEY}` })
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [{ role: "system", content: systemPrompt(req.user.role) }, ...messages]
      })
    });

    if (!response.ok) {
      console.error("Ollama error:", response.status, await response.text());

      if (response.status === 401 || response.status === 403) {
        return res.status(502).json({
          success: false,
          message: "The AI service rejected the API key. Check OLLAMA_API_KEY."
        });
      }

      return res.status(502).json({
        success: false,
        message: USE_CLOUD
          ? `The AI model "${OLLAMA_MODEL}" is not available on Ollama Cloud. Check OLLAMA_MODEL.`
          : `The AI model "${OLLAMA_MODEL}" is not available. Run: ollama pull ${OLLAMA_MODEL}`
      });
    }

    const body = await response.json();

    res.json({ success: true, reply: body.message?.content?.trim() || "(no answer)" });
  } catch (err) {
    if (err.name === "TimeoutError" || err.cause?.code === "ECONNREFUSED" || err.name === "TypeError") {
      console.error("Ollama unreachable:", err.message);
      return res.status(503).json({
        success: false,
        message: USE_CLOUD
          ? "The AI assistant could not reach Ollama Cloud. Please try again."
          : "The AI assistant is offline. Make sure Ollama is running."
      });
    }

    next(err);
  }
});

module.exports = router;
