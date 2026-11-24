# ProofHours V2: load test report

**Run:** `node server/loadgen.js <concurrency>` (Stage 6). Node 26.13.1, AMD Ryzen 7 7800X3D (16 threads), Windows 11, everything on localhost.

## What was measured
- **Real code, isolated:** the real indexer search API and the real attendance service, each a single Node process with SQLite, driven over HTTP by concurrent clients in the same machine.
- **Fake chain:** chain reads (coordinator NGO, opt-in) come from an in-memory stand-in, so the numbers measure the services, **not** a public RPC. In production every write that checks the chain adds an RPC round trip (typically 50–300 ms on public Base Sepolia endpoints).
- **Fictional data:** 10,000 events and 200 NGOs in the search index; 200 upcoming shifts; 1,000 fresh wallets.
- **Signatures:** clients sign their sign-in messages before the timed part; the server's signature check *is* timed.

## Results

### 10 concurrent clients
| Scenario | Requests | Throughput (req/s) | p50 ms | p95 ms | p99 ms | Errors |
|---|---|---|---|---|---|---|
| Search (10,000 events) | 5000 | 336 | 29.6 | 32.2 | 34.8 | 0 |
| Opportunities list (200 shifts) | 5000 | 2000 | 4.7 | 7.0 | 8.4 | 0 |
| Health check | 5000 | 11482 | 0.8 | 1.3 | 2.9 | 0 |
| Wallet sign-in (verify signature, issue session) | 1000 | 585 | 16.9 | 19.4 | 20.3 | 0 |
| Check-in (QR check, consent, overlap, capacity, insert) | 1000 | 3503 | 2.7 | 3.3 | 7.2 | 0 |

### 50 concurrent clients
| Scenario | Requests | Throughput (req/s) | p50 ms | p95 ms | p99 ms | Errors |
|---|---|---|---|---|---|---|
| Search (10,000 events) | 5000 | 336 | 148.2 | 157.2 | 161.1 | 0 |
| Opportunities list (200 shifts) | 5000 | 1996 | 24.4 | 30.1 | 40.9 | 0 |
| Health check | 5000 | 12436 | 3.6 | 5.9 | 7.3 | 0 |
| Wallet sign-in (verify signature, issue session) | 1000 | 595 | 83.6 | 89.8 | 90.1 | 0 |
| Check-in (QR check, consent, overlap, capacity, insert) | 1000 | 3870 | 12.4 | 16.9 | 17.4 | 0 |

All 1,000 check-ins were stored in both runs; no request failed.

## Findings
1. **Fixed during the test: opportunities list.** It ran one count query per shift (200 per request): 677 req/s, p95 94 ms at 50 clients. A single grouped query raised it to 1,996 req/s, p95 30 ms.
2. **Search is CPU-bound.** About 3 ms of work per query on one thread, so throughput stays at ~336 req/s and latency grows with the queue. At 10 clients p95 is 32 ms, under the 50 ms target; at 50 clients it's 157 ms. **Scale-out options:**
   - several read-only indexer processes over the same database, behind a load balancer;
   - caching popular queries;
   - Meilisearch (see the architecture doc).
3. **Sign-in is the heaviest write.** It's dominated by the secp256k1 signature check (~1.7 ms); ~590 sign-ins/s. Sessions last 2 hours, so this is rarely hit.
4. **Check-in is light** (~3,500–3,900 req/s locally). Real throughput will be bounded by the chain read for opt-in.

## What this does not show
- **Real network:** no real RPC or internet latency, no TLS, no reverse proxy, no multi-machine setup.
- **Long runs:** each scenario lasts seconds, so memory growth and soak behaviour are untested.
- **Rate limits off:** limits are disabled for the test. In production the services allow 300 (attendance) and 600 (indexer) requests per minute per client address (`RATE_LIMIT`).
- **Indexer catch-up:** not measured here; it's bounded by `getLogs` on the RPC.
