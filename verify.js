/*
 * 기획서 대조 검증 로직
 *
 * 실무 확률 검증 절차를 재현합니다.
 *   1) AI 1차 검증: 기획서 문서에서 아이템별 확률표를 추출 (AI는 읽기만 담당)
 *   2) 규칙 기반 대조: 추출한 기획서 확률과 데이터 시트 확률을 코드로 비교 (판정은 규칙이 담당)
 *   3) 사람 2차 확인: 불일치 항목만 담당자가 확인 (최종 승인은 사람이 담당)
 *
 * 브라우저에서는 window.GachaVerify, Node에서는 module.exports로 사용합니다.
 */
(function (root) {
  "use strict";

  const DEFAULT_TOLERANCE = 0.0001; // 단위: %p

  const STATUS = {
    OK: "일치",
    ROUNDING: "반올림 차이",
    MISMATCH: "확률 불일치",
    MISSING_IN_SHEET: "데이터 시트 누락",
    EXTRA_IN_SHEET: "기획서에 없는 아이템",
  };

  // ---------------------------------------------------------------
  // 공통 유틸
  // ---------------------------------------------------------------

  /** 이름 비교용 정규화: 전각/반각 통일, 공백 제거, 소문자 */
  function normalizeName(name) {
    return String(name == null ? "" : name)
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  /** "0.5%", " 12.345 ", "1,000" 같은 값을 숫자로. 실패 시 NaN */
  function parseNumber(value) {
    if (typeof value === "number") return value;
    const cleaned = String(value == null ? "" : value)
      .trim()
      .replace(/%$/, "")
      .replace(/,/g, "")
      .trim();
    if (cleaned === "" || !/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(cleaned)) return NaN;
    return Number(cleaned);
  }

  /** 기획서에 적힌 값의 소수 자릿수 (반올림 판정 기준) */
  function decimalPlaces(raw) {
    const s = String(raw == null ? "" : raw).trim().replace(/%$/, "").replace(/,/g, "");
    const m = s.match(/\.(\d+)$/);
    return m ? m[1].length : 0;
  }

  function roundTo(value, places) {
    const f = Math.pow(10, places);
    return Math.round(value * f) / f;
  }

  function collapseSpaces(text) {
    return String(text == null ? "" : text).normalize("NFKC").replace(/\s+/g, " ").trim();
  }

  // ---------------------------------------------------------------
  // 1) 기획서 확률표 입력 (수동 CSV)
  // ---------------------------------------------------------------

  /**
   * "아이템,확률(%)" 형식 텍스트를 파싱합니다. 첫 행이 숫자가 아니면 헤더로 간주합니다.
   * 반환: { items: [{name, percent, raw}], errors: [string] }
   */
  function parsePlanCsv(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const items = [];
    const errors = [];
    lines.forEach((line, i) => {
      const cols = line.split(/[,\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
      if (cols.length < 2) {
        errors.push(`${i + 1}행: 아이템과 확률 두 칸이 필요합니다.`);
        return;
      }
      const percent = parseNumber(cols[1]);
      if (Number.isNaN(percent)) {
        if (i === 0) return; // 헤더
        errors.push(`${i + 1}행: 확률 "${cols[1]}"을 숫자로 읽을 수 없습니다.`);
        return;
      }
      if (!cols[0]) {
        errors.push(`${i + 1}행: 아이템 이름이 비어 있습니다.`);
        return;
      }
      items.push({ name: cols[0], percent, raw: cols[1] });
    });
    return { items, errors };
  }

  // ---------------------------------------------------------------
  // 1) 기획서 확률표 입력 (AI 추출)
  // ---------------------------------------------------------------

  function buildExtractionPrompt(planText) {
    return [
      "아래는 게임 유료 아이템(랜덤박스/가챠)의 기획서 일부입니다.",
      "기획서에 적힌 아이템별 획득 확률만 그대로 추출하세요.",
      "",
      "규칙:",
      "- 기획서에 적힌 숫자를 바꾸거나 계산하거나 반올림하지 마세요.",
      "- 기획서에 없는 아이템이나 확률을 만들지 마세요. 확률이 적혀 있지 않은 아이템은 제외하세요.",
      "- 확률은 퍼센트(%) 기준 숫자 문자열로 적으세요. 기획서가 소수(0.05 등)로 적었다면 퍼센트로 바꾸지 말고 note에 그 사실을 적으세요.",
      "- source_text에는 그 확률이 적힌 기획서 원문 한 줄을 글자 그대로 복사하세요.",
      "- 여러 박스가 있으면 box에 박스 이름을 적으세요.",
      "",
      "출력은 아래 JSON 하나만 출력하고 다른 설명은 쓰지 마세요.",
      '{"items":[{"box":"","name":"","probability":"","source_text":"","note":""}]}',
      "",
      "<기획서>",
      planText,
      "</기획서>",
    ].join("\n");
  }

  /** AI 응답 텍스트에서 JSON 객체를 꺼냅니다. */
  function extractJson(text) {
    const s = String(text || "").trim();
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : s;
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("응답에서 JSON을 찾지 못했습니다.");
    return JSON.parse(body.slice(start, end + 1));
  }

  /**
   * AI 추출 결과를 검증합니다. AI 결과를 그대로 믿지 않고, 원문 근거가 실제로 있는지 확인합니다.
   *   - source_text가 기획서 원문에 실제로 존재하는가
   *   - source_text 안에 추출한 확률 숫자가 실제로 적혀 있는가
   * 반환: { items: [{box, name, percent, raw, sourceText, note, evidence, evidenceNote}], errors }
   */
  function validateExtraction(aiResponseText, planText) {
    const errors = [];
    let data;
    try {
      data = extractJson(aiResponseText);
    } catch (e) {
      return { items: [], errors: ["AI 응답 해석 실패: " + e.message] };
    }
    if (!data || !Array.isArray(data.items)) {
      return { items: [], errors: ['AI 응답에 "items" 배열이 없습니다.'] };
    }

    const plan = collapseSpaces(planText);
    const items = [];
    data.items.forEach((it, i) => {
      const name = String((it && it.name) || "").trim();
      const raw = String((it && it.probability) == null ? "" : it.probability).trim();
      const percent = parseNumber(raw);
      if (!name) {
        errors.push(`${i + 1}번째 항목: 아이템 이름이 없어 제외했습니다.`);
        return;
      }
      if (Number.isNaN(percent) || percent < 0 || percent > 100) {
        errors.push(`${i + 1}번째 항목(${name}): 확률 "${raw}"이 0~100 범위의 숫자가 아니어서 제외했습니다.`);
        return;
      }
      const sourceText = collapseSpaces(it.source_text);
      const numberText = raw.replace(/%$/, "");
      let evidence = true;
      let evidenceNote = "";
      if (!sourceText) {
        evidence = false;
        evidenceNote = "원문 근거 없음";
      } else if (!plan.includes(sourceText)) {
        evidence = false;
        evidenceNote = "원문에서 근거 문장을 찾지 못함";
      } else if (!sourceText.includes(numberText)) {
        evidence = false;
        evidenceNote = "근거 문장에 해당 확률 숫자가 없음";
      }
      items.push({
        box: String((it && it.box) || "").trim(),
        name,
        percent,
        raw,
        sourceText,
        note: String((it && it.note) || "").trim(),
        evidence,
        evidenceNote,
      });
    });
    return { items, errors };
  }

  // ---------------------------------------------------------------
  // 2) 규칙 기반 대조
  // ---------------------------------------------------------------

  /** 데이터 시트 가중치를 % 확률로 변환 */
  function sheetToPercent(items) {
    const total = items.reduce((s, it) => s + Number(it.weight), 0);
    return {
      total,
      items: items.map((it) => ({
        name: it.name,
        weight: Number(it.weight),
        percent: total > 0 ? (Number(it.weight) / total) * 100 : NaN,
      })),
    };
  }

  function findDuplicates(names) {
    const seen = new Map();
    const dups = new Set();
    names.forEach((n) => {
      const k = normalizeName(n);
      if (seen.has(k)) dups.add(n);
      seen.set(k, true);
    });
    return Array.from(dups);
  }

  /**
   * 기획서 확률표(plan: [{name, percent, raw}])와 데이터 시트(sheet: [{name, weight}])를 대조합니다.
   * options.tolerance: 일치로 보는 허용 오차 (%p, 기본 0.0001)
   */
  function compare(plan, sheet, options) {
    const tolerance = options && options.tolerance != null ? Number(options.tolerance) : DEFAULT_TOLERANCE;
    const sheetConv = sheetToPercent(sheet);
    const issues = [];

    const notices = [];
    const planSum = plan.reduce((s, it) => s + it.percent, 0);
    // 기획서가 반올림된 값으로 적혀 있으면 합계가 100%에서 조금 어긋날 수 있습니다.
    // 각 값의 표기 자릿수 기준 최대 반올림 오차를 더한 범위까지는 이슈가 아닌 안내로 처리합니다.
    const roundingSlack = plan.reduce(
      (s, it) => s + 0.5 * Math.pow(10, -decimalPlaces(it.raw != null ? it.raw : it.percent)),
      0
    );
    const sumGap = Math.abs(planSum - 100);
    if (sumGap > Math.max(tolerance, 1e-9)) {
      if (sumGap <= roundingSlack + 1e-9) {
        notices.push(`기획서 합계 ${formatPct(planSum)}: 표기 반올림 범위 안의 차이입니다.`);
      } else {
        issues.push(`기획서 확률 합계가 100%가 아닙니다 (합계 ${formatPct(planSum)}).`);
      }
    }
    findDuplicates(plan.map((p) => p.name)).forEach((n) =>
      issues.push(`기획서에 같은 아이템이 두 번 이상 있습니다: ${n}`)
    );
    findDuplicates(sheet.map((s) => s.name)).forEach((n) =>
      issues.push(`데이터 시트에 같은 아이템이 두 번 이상 있습니다: ${n}`)
    );
    sheet.forEach((s) => {
      if (!(Number(s.weight) > 0)) issues.push(`데이터 시트의 가중치가 0 이하입니다: ${s.name}`);
    });

    const sheetByKey = new Map();
    sheetConv.items.forEach((s) => {
      const k = normalizeName(s.name);
      if (!sheetByKey.has(k)) sheetByKey.set(k, s);
    });
    const matchedKeys = new Set();
    const rows = [];

    plan.forEach((p) => {
      const key = normalizeName(p.name);
      const s = sheetByKey.get(key);
      if (!s) {
        rows.push({
          name: p.name,
          planPct: p.percent,
          sheetPct: null,
          diff: null,
          status: STATUS.MISSING_IN_SHEET,
          note: "기획서에는 있지만 데이터 시트에 없습니다.",
        });
        return;
      }
      matchedKeys.add(key);
      const diff = s.percent - p.percent;
      let status = STATUS.OK;
      let note = "";
      if (Math.abs(diff) > tolerance) {
        const places = decimalPlaces(p.raw != null ? p.raw : p.percent);
        if (roundTo(s.percent, places) === roundTo(p.percent, places)) {
          status = STATUS.ROUNDING;
          note = `기획서 표기(소수 ${places}자리)로 반올림하면 같습니다.`;
        } else {
          status = STATUS.MISMATCH;
        }
      }
      if (s.name !== p.name) {
        note = (note ? note + " " : "") + `이름 표기 차이: 기획서 "${p.name}" / 시트 "${s.name}"`;
      }
      rows.push({ name: p.name, planPct: p.percent, sheetPct: s.percent, diff, status, note });
    });

    sheetConv.items.forEach((s) => {
      const key = normalizeName(s.name);
      if (matchedKeys.has(key)) return;
      matchedKeys.add(key);
      rows.push({
        name: s.name,
        planPct: null,
        sheetPct: s.percent,
        diff: null,
        status: STATUS.EXTRA_IN_SHEET,
        note: "데이터 시트에만 있는 아이템입니다.",
      });
    });

    const count = (st) => rows.filter((r) => r.status === st).length;
    const summary = {
      total: rows.length,
      ok: count(STATUS.OK),
      rounding: count(STATUS.ROUNDING),
      mismatch: count(STATUS.MISMATCH),
      missing: count(STATUS.MISSING_IN_SHEET),
      extra: count(STATUS.EXTRA_IN_SHEET),
      issues: issues.length,
    };
    summary.needsReview = summary.mismatch + summary.missing + summary.extra + summary.rounding;
    summary.pass = summary.needsReview === 0 && summary.issues === 0;

    return { rows, issues, notices, summary, planSum, sheetWeightTotal: sheetConv.total, tolerance };
  }

  // ---------------------------------------------------------------
  // 3) 리포트
  // ---------------------------------------------------------------

  function formatPct(v) {
    if (v == null || Number.isNaN(v)) return "-";
    return Number(v.toFixed(6)).toString() + "%";
  }

  function csvCell(v) {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** reviews: { [rowIndex]: { checked: bool, memo: string } } */
  function toReportCsv(result, reviews, meta) {
    const lines = [];
    const m = meta || {};
    lines.push(["검증 대상", m.box || ""].map(csvCell).join(","));
    lines.push(["검증 일시", m.date || new Date().toISOString()].map(csvCell).join(","));
    lines.push(["허용 오차(%p)", result.tolerance].map(csvCell).join(","));
    lines.push(["기획서 합계", formatPct(result.planSum)].map(csvCell).join(","));
    lines.push(["판정", result.summary.pass ? "통과" : `확인 필요 ${result.summary.needsReview}건`].map(csvCell).join(","));
    result.issues.forEach((i) => lines.push(["전체 이슈", i].map(csvCell).join(",")));
    (result.notices || []).forEach((i) => lines.push(["안내", i].map(csvCell).join(",")));
    lines.push("");
    lines.push(["아이템", "기획서 확률", "데이터 시트 확률", "차이(%p)", "판정", "비고", "담당자 확인", "메모"].join(","));
    result.rows.forEach((r, idx) => {
      const rv = (reviews && reviews[idx]) || {};
      lines.push(
        [
          r.name,
          formatPct(r.planPct),
          formatPct(r.sheetPct),
          r.diff == null ? "-" : Number(r.diff.toFixed(6)).toString(),
          r.status,
          r.note,
          r.status === STATUS.OK ? "-" : rv.checked ? "확인 완료" : "미확인",
          rv.memo || "",
        ]
          .map(csvCell)
          .join(",")
      );
    });
    return "﻿" + lines.join("\n");
  }

  const api = {
    DEFAULT_TOLERANCE,
    STATUS,
    normalizeName,
    parseNumber,
    decimalPlaces,
    parsePlanCsv,
    buildExtractionPrompt,
    extractJson,
    validateExtraction,
    sheetToPercent,
    compare,
    formatPct,
    toReportCsv,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GachaVerify = api;
})(typeof window !== "undefined" ? window : globalThis);
