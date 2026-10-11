// 실행: node --test test/
const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../verify.js");

const S = V.STATUS;
const byName = (result, name) => result.rows.find((r) => r.name === name);

test("기획서와 데이터 시트가 같으면 통과", () => {
  const plan = [
    { name: "전설 무기", percent: 1, raw: "1" },
    { name: "희귀 무기", percent: 9, raw: "9" },
    { name: "일반 무기", percent: 90, raw: "90" },
  ];
  const sheet = [
    { name: "전설 무기", weight: 10 },
    { name: "희귀 무기", weight: 90 },
    { name: "일반 무기", weight: 900 },
  ];
  const r = V.compare(plan, sheet);
  assert.equal(r.summary.pass, true);
  assert.equal(r.summary.ok, 3);
  assert.deepEqual(r.issues, []);
});

test("확률이 다르면 불일치로 판정하고 차이를 계산", () => {
  const plan = [
    { name: "A", percent: 1, raw: "1" },
    { name: "B", percent: 99, raw: "99" },
  ];
  const sheet = [
    { name: "A", weight: 2 },
    { name: "B", weight: 98 },
  ];
  const r = V.compare(plan, sheet);
  assert.equal(byName(r, "A").status, S.MISMATCH);
  assert.ok(Math.abs(byName(r, "A").diff - 1) < 1e-9);
  assert.equal(r.summary.pass, false);
});

test("기획서 표기 자릿수로 반올림해서 같으면 반올림 차이로 분리", () => {
  const plan = [
    { name: "A", percent: 33.33, raw: "33.33%" },
    { name: "B", percent: 33.33, raw: "33.33%" },
    { name: "C", percent: 33.34, raw: "33.34%" },
  ];
  const sheet = [
    { name: "A", weight: 1 },
    { name: "B", weight: 1 },
    { name: "C", weight: 1 },
  ];
  const r = V.compare(plan, sheet);
  assert.equal(byName(r, "A").status, S.ROUNDING);
  // 33.3333을 소수 2자리로 반올림하면 33.33이므로 C(33.34)는 반올림으로도 다름
  assert.equal(byName(r, "C").status, S.MISMATCH);
});

test("누락과 추가 아이템 검출", () => {
  const plan = [
    { name: "A", percent: 50, raw: "50" },
    { name: "B", percent: 50, raw: "50" },
  ];
  const sheet = [
    { name: "A", weight: 50 },
    { name: "Z", weight: 50 },
  ];
  const r = V.compare(plan, sheet);
  assert.equal(byName(r, "B").status, S.MISSING_IN_SHEET);
  assert.equal(byName(r, "Z").status, S.EXTRA_IN_SHEET);
  assert.equal(r.summary.missing, 1);
  assert.equal(r.summary.extra, 1);
});

test("이름은 공백·대소문자·전각을 무시하고 매칭하되 표기 차이를 남김", () => {
  const plan = [{ name: "SSR 카드", percent: 100, raw: "100" }];
  const sheet = [{ name: "ｓｓｒ카드", weight: 1 }];
  const r = V.compare(plan, sheet);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].status, S.OK);
  assert.match(r.rows[0].note, /이름 표기 차이/);
});

test("기획서 합계가 100%가 아니면 이슈, 반올림 범위면 안내", () => {
  const bad = V.compare(
    [
      { name: "A", percent: 10, raw: "10" },
      { name: "B", percent: 80, raw: "80" },
    ],
    [
      { name: "A", weight: 10 },
      { name: "B", weight: 80 },
    ]
  );
  assert.ok(bad.issues.some((i) => i.includes("합계")));

  const rounded = V.compare(
    [
      { name: "A", percent: 33.33, raw: "33.33" },
      { name: "B", percent: 33.33, raw: "33.33" },
      { name: "C", percent: 33.33, raw: "33.33" },
    ],
    [
      { name: "A", weight: 1 },
      { name: "B", weight: 1 },
      { name: "C", weight: 1 },
    ]
  );
  assert.deepEqual(rounded.issues, []);
  assert.equal(rounded.notices.length, 1);
});

test("중복 아이템과 0 이하 가중치를 이슈로 표시", () => {
  const r = V.compare(
    [
      { name: "A", percent: 50, raw: "50" },
      { name: "a", percent: 50, raw: "50" },
    ],
    [
      { name: "A", weight: 1 },
      { name: "B", weight: 0 },
    ]
  );
  assert.ok(r.issues.some((i) => i.includes("기획서에 같은 아이템")));
  assert.ok(r.issues.some((i) => i.includes("0 이하")));
});

test("수동 입력 CSV 파싱: 헤더, 퍼센트 기호, 탭 구분, 오류 행", () => {
  const { items, errors } = V.parsePlanCsv("아이템,확률\n전설,0.5%\n희귀\t4.5\n일반,abc\n,95");
  assert.deepEqual(
    items.map((i) => [i.name, i.percent, i.raw]),
    [
      ["전설", 0.5, "0.5%"],
      ["희귀", 4.5, "4.5"],
    ]
  );
  assert.equal(errors.length, 2);
});

const PLAN_TEXT = `[신년 패키지 상자]
- 전설 무기 상자: 0.5%
- 희귀 방어구: 4.5%
- 일반 재료: 95%`;

test("AI 추출 결과: 원문 근거가 있는 항목만 근거 확인", () => {
  const ai = "```json\n" + JSON.stringify({
    items: [
      { box: "신년 패키지 상자", name: "전설 무기 상자", probability: "0.5", source_text: "- 전설 무기 상자: 0.5%" },
      { box: "신년 패키지 상자", name: "희귀 방어구", probability: "5.5", source_text: "- 희귀 방어구: 4.5%" },
      { box: "신년 패키지 상자", name: "일반 재료", probability: "95", source_text: "- 일반 재료: 95% (확정)" },
      { box: "", name: "보너스 아이템", probability: "1", source_text: "" },
    ],
  }) + "\n```";
  const { items, errors } = V.validateExtraction(ai, PLAN_TEXT);
  assert.equal(errors.length, 0);
  const get = (n) => items.find((i) => i.name === n);
  assert.equal(get("전설 무기 상자").evidence, true);
  assert.equal(get("희귀 방어구").evidence, false); // 숫자를 바꿔 적음
  assert.match(get("희귀 방어구").evidenceNote, /숫자가 없음/);
  assert.equal(get("일반 재료").evidence, false); // 원문에 없는 문장
  assert.equal(get("보너스 아이템").evidence, false); // 근거 없음
});

test("AI 추출 결과: 형식 오류와 범위 밖 값은 제외", () => {
  assert.equal(V.validateExtraction("JSON이 아닌 답변", PLAN_TEXT).items.length, 0);
  assert.equal(V.validateExtraction('{"foo":1}', PLAN_TEXT).errors.length, 1);
  const { items, errors } = V.validateExtraction(
    JSON.stringify({ items: [{ name: "A", probability: "150" }, { name: "", probability: "1" }] }),
    PLAN_TEXT
  );
  assert.equal(items.length, 0);
  assert.equal(errors.length, 2);
});

test("리포트 CSV에 판정과 담당자 확인 상태 포함", () => {
  const r = V.compare(
    [
      { name: "A", percent: 1, raw: "1" },
      { name: "B", percent: 99, raw: "99" },
    ],
    [
      { name: "A", weight: 2 },
      { name: "B", weight: 98 },
    ]
  );
  const csv = V.toReportCsv(r, { 0: { checked: true, memo: "기획 확인 후 수정 요청" } }, { box: "테스트 박스" });
  assert.match(csv, /확인 필요 2건/);
  assert.match(csv, /확인 완료,기획 확인 후 수정 요청/);
  assert.match(csv, /미확인/);
});

test("추출 프롬프트에 원문과 금지 규칙 포함", () => {
  const p = V.buildExtractionPrompt(PLAN_TEXT);
  assert.ok(p.includes(PLAN_TEXT));
  assert.ok(p.includes("만들지 마세요"));
  assert.ok(p.includes("source_text"));
});
