import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyReview, applyVariantResults, canMaster, INTERVALS } from '../src/state-machine.mjs';
import { addDays } from '../src/lib/dates.mjs';

const DAY = '2026-11-04';
const mistake = (round) => ({ status: 'reviewing', review_round: round });

describe('状态机：1-3-7-30 与掌握闸门', () => {
  it('S1 做对四轮的间隔依次为 1/3/7/30 天', () => {
    for (const round of [0, 1, 2, 3]) {
      const next = applyReview({ mistake: mistake(round), result: 'correct', today: DAY });
      assert.equal(next.review_round, round + 1);
      assert.equal(next.next_review, addDays(DAY, INTERVALS[round + 1]));
      assert.equal(next.status, 'reviewing');
    }
  });

  it('S2 做错打回诊断、轮次归零', () => {
    const next = applyReview({ mistake: mistake(3), result: 'wrong', today: DAY });
    assert.deepEqual(next, {
      status: 'diagnosing', review_round: 0, next_review: null, mastered_at: null,
    });
  });

  it('S3 迟到不重置：逾期 160 天做对仍只加一轮', () => {
    const late = { status: 'reviewing', review_round: 2, next_review: '2026-05-28' };
    const next = applyReview({ mistake: late, result: 'correct', today: DAY });
    assert.equal(next.review_round, 3);
    assert.equal(next.next_review, addDays(DAY, 7));
  });

  it('S7 第 4 轮无证据：不得 mastered，30 天后再来，不卡死', () => {
    const next = applyReview({ mistake: mistake(3), result: 'correct', today: DAY, evidenceCount: 0 });
    assert.equal(next.status, 'reviewing');
    assert.equal(next.review_round, 4);
    assert.equal(next.next_review, addDays(DAY, 30));
    assert.equal(next.mastered_at, null);
  });

  it('S8(#69) 第一次到第 4 轮不掌握：排 +30 等待真实发生', () => {
    const next = applyReview({ mistake: mistake(3), result: 'correct', today: DAY, evidenceCount: 1 });
    assert.equal(next.status, 'reviewing', '30 天间隔还没发生，不得掌握');
    assert.equal(next.review_round, 4);
    assert.equal(next.next_review, addDays(DAY, 30));
  });

  it('S12(#69) 第 4 轮长间隔任务到期后完成且有证据：mastered', () => {
    // mistake(4) 没有 next_review：等待是否过去无从判定，不得掌握。
    const noDue = applyReview({ mistake: mistake(4), result: 'correct', today: DAY, evidenceCount: 1 });
    assert.equal(noDue.status, 'reviewing');
    // 排期已到期（含迟到）：完成 30 天间隔任务，有本轮证据即掌握。
    const due = { status: 'reviewing', review_round: 4, next_review: DAY };
    const next = applyReview({ mistake: due, result: 'correct', today: DAY, evidenceCount: 1 });
    assert.equal(next.status, 'mastered');
    assert.equal(next.mastered_at, DAY);
  });

  it('S9 连续做对 6 次，round 封顶 4', () => {
    let current = mistake(0);
    for (let i = 0; i < 6; i += 1) current = applyReview({ mistake: current, result: 'correct', today: DAY });
    assert.equal(current.review_round, 4);
  });

  it('S10 非法入参抛错', () => {
    assert.throws(() => applyReview({ mistake: mistake(0), result: 'maybe', today: DAY }), /invalid review result/);
    assert.throws(() => applyVariantResults({ results: [{ level: 'other', result: 'pass' }], today: DAY }), /invalid level/);
  });

  it('掌握闸门两个条件缺一不可（#69：条件看完成前的轮次）', () => {
    assert.equal(canMaster(4, 0), false);
    assert.equal(canMaster(3, 1), false, '从第 3 轮到第 4 轮只是排下长间隔任务');
    assert.equal(canMaster(4, 1), true);
  });
});

describe('状态机：三层变式', () => {
  // #67 起结果条目带两档：quality 是质量审核，student 是学生本轮作答。
  // 旧形状 {level, result} 仍被兼容（result 视为 quality），但推进必须三档 student 都是 independent。
  const allPass = [
    { level: 'surface', quality: 'pass', student: 'independent' },
    { level: 'structure', quality: 'pass', student: 'independent' },
    { level: 'context', quality: 'pass', student: 'independent' },
  ];

  it('S4 任一层质量 fail 回诊断、轮次归零', () => {
    const next = applyVariantResults({ results: [
      { level: 'surface', quality: 'pass', student: 'independent' },
      { level: 'structure', quality: 'fail', student: 'independent' },
      { level: 'context', quality: 'pass', student: 'independent' },
    ], today: DAY });
    assert.deepEqual(next, { status: 'diagnosing', review_round: 0, next_review: null, mastered_at: null });
  });

  it('S5 三层质量 pass 且三层独立作答才进复习队列', () => {
    const next = applyVariantResults({ results: allPass, today: DAY });
    assert.equal(next.status, 'reviewing');
    assert.equal(next.review_round, 0);
    assert.equal(next.next_review, addDays(DAY, 1));
  });

  it('S6 只审核一层不推进状态', () => {
    assert.equal(applyVariantResults({ results: [allPass[0]], today: DAY }), null);
    assert.equal(applyVariantResults({ results: allPass.slice(0, 2), today: DAY }), null);
  });

  it('S11(#67) 三层审核全过但学生未独立作答不推进', () => {
    for (const student of [null, 'hinted', 'unmet', 'unjudged']) {
      const results = allPass.map((item) => ({ ...item, student }));
      assert.equal(applyVariantResults({ results, today: DAY }), null, `student=${student} 不应推进`);
    }
  });
});
