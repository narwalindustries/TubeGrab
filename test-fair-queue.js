const assert = require('assert');

// Isolated Unit Test for Fair-Usage Queue and Per-Client Limits Logic
const jobs = new Map();
const downloadQueue = [];
let rrClientIndex = 0;

const MAX_GLOBAL_JOBS = 3;
const MAX_ACTIVE_PER_CLIENT = 2;
const MAX_TOTAL_PER_CLIENT = 3;

function getClientJobCounts(clientKey) {
  let active = 0, queued = 0;
  for (const j of jobs.values()) {
    if (j.clientKey === clientKey) {
      if (j.status === 'running') active++;
      else if (j.status === 'queued') queued++;
    }
  }
  return { active, queued, total: active + queued };
}

function countRunningJobs() {
  let count = 0;
  for (const j of jobs.values()) {
    if (j.status === 'running') count++;
  }
  return count;
}

function updateQueuePositions() {
  for (let i = 0; i < downloadQueue.length; i++) {
    const j = jobs.get(downloadQueue[i]);
    if (j && j.status === 'queued') {
      j.queuePosition = i + 1;
      j.stage = `In queue (#${i + 1} in line)`;
    }
  }
}

function dispatchNextQueuedJob() {
  while (countRunningJobs() < MAX_GLOBAL_JOBS && downloadQueue.length > 0) {
    const clientsInQueue = [];
    for (const id of downloadQueue) {
      const j = jobs.get(id);
      if (j && j.status === 'queued' && !clientsInQueue.includes(j.clientKey)) {
        clientsInQueue.push(j.clientKey);
      }
    }
    if (!clientsInQueue.length) {
      downloadQueue.length = 0;
      break;
    }

    let selectedJobId = null;
    const numClients = clientsInQueue.length;
    for (let i = 0; i < numClients; i++) {
      const client = clientsInQueue[(rrClientIndex + i) % numClients];
      const counts = getClientJobCounts(client);
      if (counts.active < MAX_ACTIVE_PER_CLIENT) {
        const idx = downloadQueue.findIndex(id => {
          const j = jobs.get(id);
          return j && j.clientKey === client && j.status === 'queued';
        });
        if (idx !== -1) {
          selectedJobId = downloadQueue.splice(idx, 1)[0];
          rrClientIndex = (rrClientIndex + i + 1) % numClients;
          break;
        }
      }
    }

    if (!selectedJobId) break;

    const jobToStart = jobs.get(selectedJobId);
    if (jobToStart && jobToStart.status === 'queued') {
      jobToStart.status = 'running';
      jobToStart.queuePosition = 0;
    }
  }
  updateQueuePositions();
}

function requestDownload(id, clientKey) {
  const counts = getClientJobCounts(clientKey);
  if (counts.total >= MAX_TOTAL_PER_CLIENT) {
    return { ok: false, error: 'limit_reached' };
  }
  const canStart = (counts.active < MAX_ACTIVE_PER_CLIENT) && (countRunningJobs() < MAX_GLOBAL_JOBS) && (downloadQueue.length === 0);
  const job = { id, clientKey, status: canStart ? 'running' : 'queued', queuePosition: 0 };
  jobs.set(id, job);
  if (!canStart) {
    downloadQueue.push(id);
    updateQueuePositions();
  }
  return { ok: true, status: job.status, queuePosition: job.queuePosition };
}

function finishJob(id) {
  const j = jobs.get(id);
  if (j) {
    j.status = 'done';
    dispatchNextQueuedJob();
  }
}

// --- RUN TESTS ---
console.log('Testing Fair-Usage Queue & Per-Client Limits...');

// Test 1: Client A starts download 1 -> running
const r1 = requestDownload('job1', 'clientA');
assert.strictEqual(r1.status, 'running', 'Job 1 should start running');

// Test 2: Client A starts download 2 -> running (max 2 active)
const r2 = requestDownload('job2', 'clientA');
assert.strictEqual(r2.status, 'running', 'Job 2 should start running');

// Test 3: Client A starts download 3 -> must be queued because client has 2 active!
const r3 = requestDownload('job3', 'clientA');
assert.strictEqual(r3.status, 'queued', 'Job 3 should be queued because client A already has 2 running');
assert.strictEqual(r3.queuePosition, 1, 'Job 3 queue position should be 1');

// Test 4: Client A attempts download 4 -> rejected! (max 3 total in progress)
const r4 = requestDownload('job4', 'clientA');
assert.strictEqual(r4.ok, false, 'Job 4 should be rejected because client reached total limit of 3');

// Test 5: Client B starts download 1 -> global active is 2 (< 3), client B has 0 active, but downloadQueue has Client A's job!
// Can Client B start? In our design, if queue is not empty, does Client B queue up or take the open slot?
// Let's check: if globalQueue has jobs, Client B queues and dispatchNextQueuedJob schedules round-robin.
const r5 = requestDownload('job5', 'clientB');
// Queue now has job3 (clientA) and job5 (clientB)
assert.strictEqual(r5.status, 'queued');

// Test 6: Job 1 finishes -> dispatchNextQueuedJob runs.
// Since Client A still has 1 active job (job2) and Client B has 0 active jobs:
// Round-robin picks Client A (job3) or Client B (job5). Both have < 2 active!
// So job3 (Client A) starts!
finishJob('job1');
assert.strictEqual(jobs.get('job3').status, 'running', 'Job 3 should now be promoted to running');

// Now global active = 2 (job2, job3). Total global slots = 3. Slot 3 is available!
// dispatchNextQueuedJob should also promote job5 (Client B) to running!
assert.strictEqual(jobs.get('job5').status, 'running', 'Job 5 should also be promoted to running since slot 3 opened');

// Test 7: Client B attempts another download -> Client B has 1 active, total global active is 3 (max).
// So it must be queued.
const r6 = requestDownload('job6', 'clientB');
assert.strictEqual(r6.status, 'queued', 'Job 6 should be queued because global slots are full (3/3)');

console.log('✓ All 7 Fair-Usage Queue and Concurrency Limits assertions PASSED!');
