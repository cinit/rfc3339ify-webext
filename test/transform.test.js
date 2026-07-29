"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createTransform,
  resumeTransform,
  transformText,
} = require("../src/transform.js");

const positives = [
  ["Jan 1", "01-01"],
  ["January 01", "01-01"],
  ["Jan 1, 1990", "1990-01-01"],
  ["Jan 1 1990", "1990-01-01"],
  ["28 Jul", "07-28"],
  ["28 Jul, 2001", "2001-07-28"],
  ["12 Jan 12", "??12-01-12"],
  ["12 Jan, 23", "??23-01-12"],
  ["Jan 2, 99", "??99-01-02"],
  ["Jan 2 99", "??99-01-02"],
  ["2 Jan, 99", "??99-01-02"],
  ["2 Jan 99", "??99-01-02"],
  ["Jan 1 at noon", "01-01 at noon"],
  ["Jan 1, pending", "01-01, pending"],
  ["Jan 1 01:00 PM", "01-01 13:00"],
  ["Jan 1,01:00 PM", "01-01,13:00"],
  ["Jan 1 123 Feb 2", "Jan 1 123 02-02"],
  ["Tue, 28 Jul 2026 18:00:58 +0000", "Tue, 2026-07-28 18:00:58 +0000"],
  ["星期二, 28 Jul 2026 01:00 PM +08:00", "星期二, 2026-07-28 13:00 +08:00"],
  ["12:00 AM", "00:00"],
  ["12:00 PM", "12:00"],
  ["01:00 PM", "13:00"],
  ["01:02:03 AM", "01:02:03"],
  ["07:59AM", "07:59"],
  ["07:59 AM.", "07:59."],
  ["07:59a.m.", "07:59"],
  ["07:59:60 p.m.", "19:59:60"],
  ["Feb 29", "02-29"],
  ["Feb 29, 00", "??00-02-29"],
  ["Feb 29 2024", "2024-02-29"],
  ["Jan 1 and Dec 31, 1999 at 11:59 pm", "01-01 and 1999-12-31 at 23:59"],
];

const unchanged = [
  "Jan 1, 123",
  "Jan 1         1990",
  "Jan 1 1990x",
  "Jan 1 123abc",
  "Jan 1 , 1990",
  "Jan 1,, 1990",
  "Jan 1,1990",
  "Jan 1 0000",
  "Jan 1st",
  "Feb 29, 01",
  "Feb 29, 2025",
  "Feb 29, 1900",
  "Apr 31",
  "Jan 0",
  "Jan 32",
  "Mon Sep 17 00:00:00 2001",
  "Sep 17 99:00:00 2001",
  "07:59:59.123 AM",
  "07:59 P.M.",
  "07:59         AM",
  "00:00 AM",
  "13:00 PM",
  "01:60 PM",
  "01:59:61 PM",
  "01:02:03:04 PM",
  "01::03:04 PM",
  "01::: PM",
  "Already 2026-07-28 18:00:58Z",
  "fooJan 1",
  "éJan 1",
  "变量Jan 1",
  "AM_variable",
  "jAn 1",
  "1 jAn",
  "Mayday 1",
  "Jan         1",
];

test("normative positive examples", () => {
  for (const [input, expected] of positives) {
    assert.equal(transformText(input), expected, input);
  }
});

test("normative refusal and unsupported examples", () => {
  for (const input of unchanged) {
    assert.equal(transformText(input), input, input);
  }
});

test("all approved month spellings and casings", () => {
  const months = [
    [1, "jan", "january"], [2, "feb", "february"],
    [3, "mar", "march"], [4, "apr", "april"], [5, "may"],
    [6, "jun", "june"], [7, "jul", "july"],
    [8, "aug", "august"], [9, "sep", "sept", "september"],
    [10, "oct", "october"], [11, "nov", "november"],
    [12, "dec", "december"],
  ];
  for (const [number, ...bases] of months) {
    const expected = `${String(number).padStart(2, "0")}-01`;
    for (const base of bases) {
      const variants = [
        base,
        base[0].toUpperCase() + base.slice(1),
        base.toUpperCase(),
      ];
      for (const variant of variants) {
        assert.equal(transformText(`${variant} 1`), expected, variant);
        assert.equal(transformText(`1 ${variant}`), expected, `day-first ${variant}`);
      }
    }
  }
});

test("calendar validation is exhaustive across fields and representative years", () => {
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const leap = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximumDay = (month, isLeap) => {
    if (month === 2) return isLeap ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  };

  for (const year of [1, 4, 100, 400, 1900, 2000, 2024, 2025, 9999]) {
    const yearText = String(year).padStart(4, "0");
    for (let month = 1; month <= 12; month += 1) {
      for (let day = 1; day <= 31; day += 1) {
        const input = `${monthNames[month - 1]} ${day} ${yearText}`;
        const expected = day <= maximumDay(month, leap(year))
          ? `${yearText}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
          : input;
        assert.equal(transformText(input), expected, input);
      }
    }
  }

  for (let year = 0; year <= 99; year += 1) {
    const yearText = String(year).padStart(2, "0");
    const input = `29 Feb ${yearText}`;
    const expected = year % 4 === 0 ? `??${yearText}-02-29` : input;
    assert.equal(transformText(input), expected, input);
  }
});

test("every accepted hour, minute, and meridiem spelling", () => {
  for (const meridiem of ["AM", "PM", "am", "pm", "a.m.", "p.m."]) {
    const isPm = meridiem[0] === "P" || meridiem[0] === "p";
    for (let hour = 1; hour <= 12; hour += 1) {
      for (let minute = 0; minute <= 59; minute += 1) {
        const hourText = String(hour).padStart(2, "0");
        const minuteText = String(minute).padStart(2, "0");
        const hour24 = isPm ? (hour === 12 ? 12 : hour + 12) : (hour === 12 ? 0 : hour);
        assert.equal(transformText(`${hourText}:${minuteText} ${meridiem}`),
          `${String(hour24).padStart(2, "0")}:${minuteText}`);
      }
    }
  }
  for (const second of ["00", "59", "60"]) {
    assert.equal(transformText(`1:02:${second} PM`), `13:02:${second}`);
  }
});

test("accepted whitespace set and limits", () => {
  for (const whitespace of [" ", "\t", "\n", "\r", "\f", "\u00a0"]) {
    assert.equal(transformText(`Jan${whitespace}1`), "01-01");
    assert.equal(transformText(`1${whitespace}Jan${whitespace}99`), "??99-01-01");
    assert.equal(transformText(`01:00${whitespace}PM`), "13:00");
  }
  assert.equal(transformText(`Jan${" ".repeat(8)}1`), "01-01");
  assert.equal(transformText(`Jan${" ".repeat(9)}1`), `Jan${" ".repeat(9)}1`);
  assert.equal(transformText(`Jan 1${" ".repeat(8)}1990`), "1990-01-01");
  assert.equal(transformText(`Jan 1${" ".repeat(9)}1990`), `Jan 1${" ".repeat(9)}1990`);
  assert.equal(transformText(`01:00${" ".repeat(8)}PM`), "13:00");
  assert.equal(transformText(`01:00${" ".repeat(9)}PM`), `01:00${" ".repeat(9)}PM`);
});

test("year precedence refuses invalid longer envelopes", () => {
  const cases = [
    "Feb 29 2025",
    "Feb 29 01",
    "Jan 1 1990x",
    "Jan 1 123",
    "Jan 1 12345",
    "Jan 1,, 90",
  ];
  for (const input of cases) assert.equal(transformText(input), input);
  assert.equal(transformText("Jan 1 1990 Feb 2"), "1990-01-01 02-02");
  assert.equal(transformText("Jan 1 90 Feb 2"), "??90-01-01 02-02");
});

test("Unicode-aware boundaries include marks, numbers, connector punctuation, and joiners", () => {
  for (const prefix of ["a", "é", "变", "1", "_", "\u0301", "\u200c", "\u200d"]) {
    const input = `${prefix}Jan 1`;
    assert.equal(transformText(input), input);
  }
  // An adjacent ASCII digit is part of the maximal DAY_FIELD itself (for
  // example, "Jan 11"), so use a non-ASCII Unicode number for this boundary.
  for (const suffix of ["a", "é", "变", "١", "_", "\u0301", "\u200c", "\u200d"]) {
    const input = `Jan 1${suffix}`;
    assert.equal(transformText(input), input);
    const time = `01:00 PM${suffix}`;
    assert.equal(transformText(time), time);
  }
  assert.equal(transformText("(Jan 1)"), "(01-01)");
});

test("every resumable budget agrees with the convenience driver", () => {
  const inputs = positives.map(([input]) => input).concat(unchanged, [
    `Jan 1${" ,".repeat(200)}123456789 Feb 2`,
    `${"9".repeat(500)} Jan 1`,
    `01:00${" ".repeat(500)}PM Jan 1`,
    "lone surrogates \ud800 Jan 1 \udc00 01:00 PM",
  ]);
  for (const input of inputs) {
    const expected = transformText(input);
    for (const budget of [1, 2, 3, 7, 64]) {
      const state = createTransform(input);
      let resumes = 0;
      for (;;) {
        const result = resumeTransform(state, budget);
        resumes += 1;
        assert.ok(resumes < input.length * 20 + 1000, `progress stalled: ${input}`);
        if (result.status === "done") {
          assert.equal(result.value, expected, `budget ${budget}: ${input}`);
          break;
        }
      }
    }
  }
});

test("idempotence for deterministic pseudo-random JavaScript strings", () => {
  let seed = 0x12345678;
  const alphabet = "JanFebMARseptember0123456789 :,._AMPMé变量\u0301\u200d\ud800";
  for (let sample = 0; sample < 2000; sample += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const length = seed % 160;
    let input = "";
    for (let index = 0; index < length; index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      input += alphabet[seed % alphabet.length];
    }
    const once = transformText(input);
    assert.equal(transformText(once), once);
  }
});

test("long recognition runs yield and remain linear", () => {
  const size = 100_000;
  const inputs = [
    "9".repeat(size),
    `Jan 1${" ,".repeat(size / 2)}123`,
    `01:00${" ".repeat(size)}PM`,
    `01${":0".repeat(size / 2)} PM`,
    `Sep 17 ${"9".repeat(size)}:00:00 2001`,
  ];
  for (const input of inputs) {
    const state = createTransform(input);
    let calls = 0;
    for (;;) {
      const result = resumeTransform(state, 17);
      calls += 1;
      if (result.status === "done") {
        assert.equal(result.value, input);
        break;
      }
      assert.ok(calls <= input.length / 2 + 100, "scanner made sublinear progress");
    }
    assert.ok(calls < input.length / 2, "scanner appears to rescan a growing prefix");
  }
});

test("API validates state and step budget", () => {
  assert.throws(() => createTransform(null), TypeError);
  const state = createTransform("Jan 1");
  assert.throws(() => resumeTransform(state, 0), RangeError);
  assert.throws(() => resumeTransform(state, 1.5), RangeError);
});
