import { describe, expect, it, vi, beforeEach } from 'vitest';
  it('head push → pr_head_changed + files remapped (module added and removed)', async () => {
    github.pulls = [
      pull(42, { head_sha: 'head-42-A', files: [{ filename: 'src/auth/login.ts' }] }),
    ];
    const worker = newWorker(db, github);
    const first = await github.events(worker);
    console.log('DBG-FIRST-TYPES:', JSON.stringify(first.map(e => e.eventType)));
    const firstMap = first.find((e) => e.eventType === 'pr_modules_mapped');
    expect((firstMap!.detail as { modules: string[] }).modules).toEqual(['auth']);

    // HEAD B：新增 payment 文件 → Auth + Payment
    github.pulls = [pull(42, { head_sha: 'head-42-B', files: [
      { filename: 'src/auth/login.ts' },
      { filename: 'src/payment/order.ts' },
    ] })];
    const second = await github.events(worker);
    console.log('DBG-SECOND-TYPES:', JSON.stringify(second.map(e => e.eventType)));
    expect(second.some((e) => e.eventType === 'pr_head_changed')).toBe(true);
    const remap = second.find((e) => e.eventType === 'pr_modules_mapped');
    expect((remap!.detail as { modules: string[] }).modules.sort()).toEqual(['auth', 'payment']);

    // HEAD C：移除 auth 变更 → 仅 Payment（失效映射必须被删除）
    github.pulls = [pull(42, { head_sha: 'head-42-C', files: [
      { filename: 'src/payment/order.ts' },
    ] })];
    const third = await github.events(worker);
    const remap3 = third.find((e) => e.eventType === 'pr_modules_mapped');
    expect((remap3!.detail as { modules: string[] }).modules).toEqual(['payment']);
  });

