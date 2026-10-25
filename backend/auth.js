const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// Signing key for login tokens. Set AUTH_SECRET in production so tokens
// stay valid across server restarts and serverless instances.
const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");

if (!process.env.AUTH_SECRET) {
  console.warn("AUTH_SECRET is not set; using a temporary key (logins reset on restart)");
}

// Hash a password as "salt:hash" (hex)
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(":");
  if (!saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Constant-time string comparison
function safeEqual(a, b) {
  const hashA = crypto.createHash("sha256").update(String(a)).digest();
  const hashB = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

const sign = data =>
  crypto.createHmac("sha256", SECRET).update(data).digest("base64url");

// Token format: base64url(JSON payload) + "." + HMAC signature
function createToken(payload) {
  const data = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS })
  ).toString("base64url");

  return `${data}.${sign(data)}`;
}

function readToken(token) {
  const [data, signature] = String(token || "").split(".");
  if (!data || !signature || !safeEqual(signature, sign(data))) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

const unauthorized = (res, message = "Please log in") =>
  res.status(401).json({ success: false, message });

// Middleware: require a valid token, optionally limited to certain roles.
// Students who still have to change their password may only reach routes
// that pass { allowPasswordChange: true }.
function requireAuth({ roles = null, allowPasswordChange = false } = {}) {
  return (req, res, next) => {
    const header = req.get("Authorization") || "";
    const user = readToken(header.replace(/^Bearer\s+/i, ""));

    if (!user) return unauthorized(res);

    if (user.mustChangePassword && !allowPasswordChange) {
      return res.status(403).json({
        success: false,
        message: "You must change your password first"
      });
    }

    if (roles && !roles.includes(user.role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this resource"
      });
    }

    req.user = user;
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  safeEqual,
  createToken,
  requireAuth
};
