/*
 * RFC3339ify's pure, locale-independent text transformer.
 *
 * The browser content script and Node tests both load this file directly.  It
 * deliberately has no DOM or extension-API dependency.
 */
(function exposeTransform(globalObject, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    Object.defineProperty(globalObject, "RFC3339ifyTransform", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze(api),
    });
  }
})(typeof globalThis === "object" ? globalThis : this, function makeTransform() {
  "use strict";

  const RESULT_REPLACE = "replace";
  const RESULT_REFUSE = "refuse";
  const RESULT_NO_MATCH = "no-match";

  const BASE_MONTHS = Object.freeze([
    ["jan", 1], ["january", 1],
    ["feb", 2], ["february", 2],
    ["mar", 3], ["march", 3],
    ["apr", 4], ["april", 4],
    ["may", 5],
    ["jun", 6], ["june", 6],
    ["jul", 7], ["july", 7],
    ["aug", 8], ["august", 8],
    ["sep", 9], ["sept", 9], ["september", 9],
    ["oct", 10], ["october", 10],
    ["nov", 11], ["november", 11],
    ["dec", 12], ["december", 12],
  ]);

  const MONTH_TOKENS = Object.freeze(BASE_MONTHS.flatMap(([base, month]) => [
    Object.freeze([base, month]),
    Object.freeze([base[0].toUpperCase() + base.slice(1), month]),
    Object.freeze([base.toUpperCase(), month]),
  ]).sort((left, right) => right[0].length - left[0].length));

  const WORDISH = /[\p{L}\p{M}\p{N}\p{Pc}]/u;

  function isAsciiDigitCode(code) {
    return code >= 0x30 && code <= 0x39;
  }

  function isAsciiDigitAt(input, index) {
    return index < input.length && isAsciiDigitCode(input.charCodeAt(index));
  }

  function isWhitespaceAt(input, index) {
    if (index >= input.length) return false;
    switch (input.charCodeAt(index)) {
      case 0x09: // tab
      case 0x0a: // LF
      case 0x0c: // form feed
      case 0x0d: // CR
      case 0x20: // space
      case 0xa0: // no-break space
      case 0x202f: // narrow no-break space
        return true;
      default:
        return false;
    }
  }

  function codePointLengthAt(input, index) {
    const code = input.charCodeAt(index);
    return code >= 0xd800 && code <= 0xdbff &&
      index + 1 < input.length &&
      input.charCodeAt(index + 1) >= 0xdc00 &&
      input.charCodeAt(index + 1) <= 0xdfff ? 2 : 1;
  }

  function previousCodePoint(input, index) {
    if (index <= 0) return "";
    const last = input.charCodeAt(index - 1);
    if (last >= 0xdc00 && last <= 0xdfff && index >= 2) {
      const first = input.charCodeAt(index - 2);
      if (first >= 0xd800 && first <= 0xdbff) {
        return input.slice(index - 2, index);
      }
    }
    return input[index - 1];
  }

  function isWordishCodePoint(value) {
    return value === "\u200c" || value === "\u200d" || WORDISH.test(value);
  }

  function hasStartBoundary(input, index) {
    return index === 0 || !isWordishCodePoint(previousCodePoint(input, index));
  }

  function hasEndBoundary(input, index) {
    if (index >= input.length) return true;
    const value = String.fromCodePoint(input.codePointAt(index));
    return !isWordishCodePoint(value);
  }

  function* scanDigits(input, start) {
    let index = start;
    while (isAsciiDigitAt(input, index)) {
      index += 1;
      yield;
    }
    return index;
  }

  function* scanWhitespace(input, start) {
    let index = start;
    while (isWhitespaceAt(input, index)) {
      index += 1;
      yield;
    }
    return index;
  }

  function* scanSuffixSeparators(input, start) {
    let index = start;
    let commaCount = 0;
    let whitespaceCount = 0;
    while (index < input.length &&
      (isWhitespaceAt(input, index) || input.charCodeAt(index) === 0x2c)) {
      if (input.charCodeAt(index) === 0x2c) commaCount += 1;
      else whitespaceCount += 1;
      index += 1;
      yield;
    }
    return { end: index, commaCount, whitespaceCount };
  }

  function matchMonth(input, start) {
    for (const [token, month] of MONTH_TOKENS) {
      if (input.startsWith(token, start)) {
        return { end: start + token.length, month };
      }
    }
    return null;
  }

  function matchMeridiemLike(input, start) {
    const first = input[start];
    if (first !== "A" && first !== "a" && first !== "P" && first !== "p") {
      return null;
    }

    if (input[start + 1] === "." &&
      (input[start + 2] === "M" || input[start + 2] === "m") &&
      input[start + 3] === ".") {
      return { end: start + 4, token: input.slice(start, start + 4) };
    }

    if (input[start + 1] === "M" || input[start + 1] === "m") {
      return { end: start + 2, token: input.slice(start, start + 2) };
    }

    return null;
  }

  function isAcceptedMeridiem(token) {
    return token === "AM" || token === "PM" ||
      token === "am" || token === "pm" ||
      token === "a.m." || token === "p.m.";
  }

  function twoDigits(value) {
    return value < 10 ? `0${value}` : String(value);
  }

  function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }

  function daysInMonth(month, leap) {
    switch (month) {
      case 2: return leap ? 29 : 28;
      case 4:
      case 6:
      case 9:
      case 11: return 30;
      default: return 31;
    }
  }

  function parseDay(input, start, end) {
    const length = end - start;
    if (length < 1 || length > 2) return null;
    const value = Number(input.slice(start, end));
    return value >= 1 && value <= 31 ? value : null;
  }

  function isPossibleDate(month, day, yearKind, year) {
    if (day === null) return false;
    if (yearKind === "year4") {
      if (year < 1 || year > 9999) return false;
      return day <= daysInMonth(month, isLeapYear(year));
    }
    if (yearKind === "year2") {
      return day <= daysInMonth(month, year % 4 === 0);
    }
    return day <= daysInMonth(month, true);
  }

  function acceptedYearSeparators(input, start, separator) {
    const length = separator.end - start;
    if (separator.commaCount === 0) {
      return length >= 1 && length <= 8 && separator.whitespaceCount === length;
    }
    return separator.commaCount === 1 && input[start] === "," &&
      separator.whitespaceCount >= 1 && separator.whitespaceCount <= 8 &&
      length === separator.whitespaceCount + 1;
  }

  function formatDate(month, day, yearKind, yearText) {
    const suffix = `${twoDigits(month)}-${twoDigits(day)}`;
    if (yearKind === "year4") return `${yearText}-${suffix}`;
    if (yearKind === "year2") return `??${yearText}-${suffix}`;
    return suffix;
  }

  function* matchGitLike(input, firstFieldEnd) {
    if (input[firstFieldEnd] !== ":") return null;

    const minuteStart = firstFieldEnd + 1;
    const minuteEnd = yield* scanDigits(input, minuteStart);
    if (minuteEnd === minuteStart) return null;

    let timeEnd = minuteEnd;
    if (input[timeEnd] === ":") {
      const secondStart = timeEnd + 1;
      const secondEnd = yield* scanDigits(input, secondStart);
      if (secondEnd === secondStart) return null;
      timeEnd = secondEnd;
    }

    if (!isWhitespaceAt(input, timeEnd)) return null;
    const yearStart = yield* scanWhitespace(input, timeEnd);
    const yearEnd = yield* scanDigits(input, yearStart);
    if (yearEnd === yearStart) return null;
    return { end: yearEnd };
  }

  function* finishDate(input, core) {
    const separator = yield* scanSuffixSeparators(input, core.end);
    let suffixDigitsStart = separator.end;

    if (separator.end > core.end && isAsciiDigitAt(input, suffixDigitsStart)) {
      const suffixDigitsEnd = yield* scanDigits(input, suffixDigitsStart);

      if (input[suffixDigitsEnd] === ":") {
        const separatorsAreWhitespace = separator.commaCount === 0 &&
          separator.whitespaceCount === separator.end - core.end;
        if (separatorsAreWhitespace) {
          const gitLike = yield* matchGitLike(input, suffixDigitsEnd);
          if (gitLike !== null) {
            return { kind: RESULT_REFUSE, end: gitLike.end };
          }
        }
        return finishYearless(input, core);
      }

      const yearLength = suffixDigitsEnd - suffixDigitsStart;
      if (!acceptedYearSeparators(input, core.end, separator) ||
        (yearLength !== 4 && yearLength !== 2)) {
        return { kind: RESULT_REFUSE, end: suffixDigitsEnd };
      }

      const yearKind = yearLength === 4 ? "year4" : "year2";
      const yearText = input.slice(suffixDigitsStart, suffixDigitsEnd);
      const year = Number(yearText);
      const day = parseDay(input, core.dayStart, core.dayEnd);
      if (!isPossibleDate(core.month, day, yearKind, year) ||
        !hasEndBoundary(input, suffixDigitsEnd)) {
        return { kind: RESULT_REFUSE, end: suffixDigitsEnd };
      }

      return {
        kind: RESULT_REPLACE,
        end: suffixDigitsEnd,
        replacement: formatDate(core.month, day, yearKind, yearText),
      };
    }

    return finishYearless(input, core);
  }

  function finishYearless(input, core) {
    const day = parseDay(input, core.dayStart, core.dayEnd);
    if (!isPossibleDate(core.month, day, "yearless", 0) ||
      !hasEndBoundary(input, core.end)) {
      return { kind: RESULT_REFUSE, end: core.end };
    }
    return {
      kind: RESULT_REPLACE,
      end: core.end,
      replacement: formatDate(core.month, day, "yearless", ""),
    };
  }

  function* matchTime(input, start, hourEnd) {
    let fieldEnd = hourEnd;
    let fieldCount = 0;
    let hasEmptyField = false;
    let minuteStart = -1;
    let minuteEnd = -1;
    let secondStart = -1;
    let secondEnd = -1;
    while (input[fieldEnd] === ":") {
      fieldCount += 1;
      fieldEnd += 1;
      // Empty colon fields must still consume a bounded scanner step.
      yield;
      const fieldStart = fieldEnd;
      fieldEnd = yield* scanDigits(input, fieldStart);
      if (fieldEnd === fieldStart) hasEmptyField = true;
      if (fieldCount === 1) {
        minuteStart = fieldStart;
        minuteEnd = fieldEnd;
      } else if (fieldCount === 2) {
        secondStart = fieldStart;
        secondEnd = fieldEnd;
      }
    }

    let fraction = false;
    if (fieldCount >= 2 && input[fieldEnd] === "." &&
      isAsciiDigitAt(input, fieldEnd + 1)) {
      fraction = true;
      fieldEnd = yield* scanDigits(input, fieldEnd + 1);
    }

    const whitespaceStart = fieldEnd;
    const meridiemStart = yield* scanWhitespace(input, whitespaceStart);
    const meridiem = matchMeridiemLike(input, meridiemStart);
    if (meridiem === null) {
      return { kind: RESULT_REFUSE, end: hourEnd };
    }

    const hourLength = hourEnd - start;
    const minuteLength = minuteStart === -1 ? 0 : minuteEnd - minuteStart;
    const secondLength = secondStart === -1 ? 0 : secondEnd - secondStart;
    const whitespaceLength = meridiemStart - whitespaceStart;
    const hour = hourLength <= 2 ? Number(input.slice(start, hourEnd)) : -1;
    const minute = minuteLength === 2 ? Number(input.slice(minuteStart, minuteEnd)) : -1;
    const second = secondLength === 2 ? Number(input.slice(secondStart, secondEnd)) : -1;
    const valid = hourLength >= 1 && hourLength <= 2 && hour >= 1 && hour <= 12 &&
      !hasEmptyField && (fieldCount === 1 || fieldCount === 2) &&
      minuteLength === 2 && minute >= 0 && minute <= 59 &&
      (fieldCount === 1 || (secondLength === 2 && second >= 0 && second <= 60)) &&
      whitespaceLength <= 8 && !fraction &&
      isAcceptedMeridiem(meridiem.token) && hasEndBoundary(input, meridiem.end);

    if (!valid) {
      return { kind: RESULT_REFUSE, end: meridiem.end };
    }

    const isPm = meridiem.token[0] === "P" || meridiem.token[0] === "p";
    const hour24 = isPm ? (hour === 12 ? 12 : hour + 12) : (hour === 12 ? 0 : hour);
    let replacement = `${twoDigits(hour24)}:${input.slice(minuteStart, minuteEnd)}`;
    if (fieldCount === 2) replacement += `:${input.slice(secondStart, secondEnd)}`;
    return { kind: RESULT_REPLACE, end: meridiem.end, replacement };
  }

  function* matchCandidate(input, start) {
    if (!hasStartBoundary(input, start)) {
      return { kind: RESULT_NO_MATCH };
    }

    if (isAsciiDigitAt(input, start)) {
      const dayOrHourEnd = yield* scanDigits(input, start);
      if (input[dayOrHourEnd] === ":") {
        return yield* matchTime(input, start, dayOrHourEnd);
      }

      const separatorEnd = yield* scanWhitespace(input, dayOrHourEnd);
      const separatorLength = separatorEnd - dayOrHourEnd;
      if (separatorLength >= 1 && separatorLength <= 8) {
        const month = matchMonth(input, separatorEnd);
        if (month !== null) {
          return yield* finishDate(input, {
            dayStart: start,
            dayEnd: dayOrHourEnd,
            month: month.month,
            end: month.end,
          });
        }
      }

      // No supported token can begin inside a maximal ASCII digit run.
      return { kind: RESULT_REFUSE, end: dayOrHourEnd };
    }

    const month = matchMonth(input, start);
    if (month === null) return { kind: RESULT_NO_MATCH };

    const dayStart = yield* scanWhitespace(input, month.end);
    const separatorLength = dayStart - month.end;
    if (separatorLength < 1 || separatorLength > 8 ||
      !isAsciiDigitAt(input, dayStart)) {
      return { kind: RESULT_NO_MATCH };
    }

    const dayEnd = yield* scanDigits(input, dayStart);
    return yield* finishDate(input, {
      dayStart,
      dayEnd,
      month: month.month,
      end: dayEnd,
    });
  }

  function createTransform(input) {
    if (typeof input !== "string") {
      throw new TypeError("createTransform input must be a string");
    }
    return {
      input,
      offset: 0,
      candidateStart: 0,
      candidate: null,
      outputPieces: null,
      unchangedStart: 0,
      done: false,
      result: undefined,
    };
  }

  function finishTransform(state) {
    if (state.outputPieces === null) return state.input;
    state.outputPieces.push(state.input.slice(state.unchangedStart));
    return state.outputPieces.join("");
  }

  function resumeTransform(state, maxScannerSteps) {
    if (!state || typeof state !== "object" || typeof state.input !== "string") {
      throw new TypeError("resumeTransform state must come from createTransform");
    }
    if (!Number.isSafeInteger(maxScannerSteps) || maxScannerSteps <= 0) {
      throw new RangeError("maxScannerSteps must be a positive safe integer");
    }
    if (state.done) return { status: "done", value: state.result };

    let remaining = maxScannerSteps;
    while (remaining > 0) {
      if (state.offset >= state.input.length) {
        state.done = true;
        state.result = finishTransform(state);
        return { status: "done", value: state.result };
      }

      if (state.candidate === null) {
        state.candidateStart = state.offset;
        state.candidate = matchCandidate(state.input, state.offset);
      }

      const iteration = state.candidate.next();
      remaining -= 1;
      if (!iteration.done) continue;

      const match = iteration.value;
      state.candidate = null;
      if (match.kind === RESULT_REPLACE) {
        if (state.outputPieces === null) state.outputPieces = [];
        state.outputPieces.push(
          state.input.slice(state.unchangedStart, state.candidateStart),
          match.replacement,
        );
        state.unchangedStart = match.end;
        state.offset = match.end;
      } else if (match.kind === RESULT_REFUSE) {
        state.offset = Math.max(match.end, state.offset + 1);
      } else {
        state.offset += codePointLengthAt(state.input, state.offset);
      }
    }

    return { status: "yield" };
  }

  function transformText(input) {
    const state = createTransform(input);
    for (;;) {
      const result = resumeTransform(state, 4096);
      if (result.status === "done") return result.value;
    }
  }

  return Object.freeze({ createTransform, resumeTransform, transformText });
});
