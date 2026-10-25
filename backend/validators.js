// Field validators: each returns the cleaned value or throws a message

const textField = ({ required = true, max = 120 } = {}) => (value, label) => {
  const text = value === null || value === undefined ? "" : String(value).trim();

  if (required && !text) throw `${label} is required`;
  if (text.length > max) throw `${label} must be at most ${max} characters`;
  return text;
};

const numberField = ({ min = 0, max, decimals = 2 }) => (value, label) => {
  const number = Number(value);

  if (value === "" || value === null || !Number.isFinite(number) ||
      number < min || number > max) {
    throw `${label} must be a number from ${min} to ${max}`;
  }

  return Math.round(number * 10 ** decimals) / 10 ** decimals;
};

const patternField = (regex, hint) => (value, label) => {
  const text = String(value ?? "").trim();

  if (!regex.test(text)) throw `${label} must be ${hint}`;
  return text;
};

const timeField = patternField(/^([01]\d|2[0-3]):[0-5]\d$/, "a time like 08:30");
const dateField = patternField(/^\d{4}-\d{2}-\d{2}$/, "a date like 2026-08-15");

// 1.00 (highest) to 5.00 (failed), INC, DRP, or blank (not yet posted)
function gradeField(value, label) {
  const text = String(value ?? "").trim().toUpperCase();

  if (!text || text === "INC" || text === "DRP") return text;

  const number = Number(text);

  if (!Number.isFinite(number) || number < 1 || number > 5) {
    throw `${label} must be 1.00 to 5.00, INC, DRP, or blank`;
  }

  return number.toFixed(2);
}

module.exports = {
  textField,
  numberField,
  patternField,
  timeField,
  dateField,
  gradeField
};
