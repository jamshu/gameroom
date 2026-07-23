// Runnable check for the snapshot cache (TTL + in-flight coalescing).
// Run: node src/lib/server/snapshot-cache-check.js
import assert from 'node:assert';
import { createSnapshotCache } from './roomcache.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// counting async fetcher — resolves on a later tick so coalescing has a window.
function counter() {
	let calls = 0;
	const fn = async (key) => {
		calls++;
		await sleep(5);
		return `v${calls}:${key}`;
	};
	return { fn, calls: () => calls };
}

// (a) hit within TTL does NOT re-invoke the fetcher.
{
	const c = counter();
	const cache = createSnapshotCache(c.fn, 50);
	const a = await cache.get('r1');
	const b = await cache.get('r1');
	assert.equal(a, b, 'same cached value');
	assert.equal(c.calls(), 1, 'second call within TTL served from cache');
}

// (b) after TTL the fetcher runs again.
{
	const c = counter();
	const cache = createSnapshotCache(c.fn, 20);
	await cache.get('r1');
	await sleep(30);
	await cache.get('r1');
	assert.equal(c.calls(), 2, 'expired entry re-fetched');
}

// (c) N concurrent misses coalesce into ONE fetch.
{
	const c = counter();
	const cache = createSnapshotCache(c.fn, 50);
	const results = await Promise.all([1, 2, 3, 4, 5].map(() => cache.get('r1')));
	assert.equal(c.calls(), 1, 'concurrent misses hit the fetcher once');
	assert.ok(results.every((r) => r === results[0]), 'all share the one result');
}

// (d) fresh bypasses a valid cache entry.
{
	const c = counter();
	const cache = createSnapshotCache(c.fn, 1000);
	await cache.get('r1');
	await cache.get('r1', { fresh: true });
	assert.equal(c.calls(), 2, 'fresh forces a re-fetch');
}

// (e) a failed fetch is not cached — next call retries.
{
	let calls = 0;
	const cache = createSnapshotCache(async () => {
		calls++;
		if (calls === 1) throw new Error('boom');
		return 'ok';
	}, 1000);
	await assert.rejects(cache.get('r1'), /boom/);
	assert.equal(await cache.get('r1'), 'ok', 'retried after failure');
	assert.equal(calls, 2);
}

console.log('snapshot-cache-check: all assertions passed');
