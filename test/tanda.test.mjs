// Private Tanda tests. They run the compiled contract logic with the official
// @midnight-ntwrk/compact-runtime, no node, indexer or proof server needed.
import { describe, it, expect } from 'vitest';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits } from '../contract/managed/tanda/contract/index.js';

const COIN = '0'.repeat(64);
const ADDR = RT.sampleContractAddress();
const key = (n) => { const a = new Uint8Array(32); a[0] = 0xab; a[31] = n; return a; };
const hex = (b) => Buffer.from(b).toString('hex');

const ORGANIZER = key(1);
const ANA = key(10), BETO = key(11), CARLA = key(12), OUTSIDER = key(99);
const SEED = key(200);
const AMOUNT = 100n;

const witnesses = {
  secretKey: ({ privateState }) => [privateState, privateState.secretKey],
  memberPath: ({ privateState, ledger: l }, leaf) => [privateState, privateState.forgedPath ?? l.members.findPathForLeaf(leaf)],
};

const stateOf = (ctx) => ledger(ctx.callContext.currentQueryContext.state);

async function deploy(size = 3n, amount = AMOUNT) {
  const contract = new Contract(witnesses);
  const ctor = await contract.initialState(RT.createConstructorContext({ secretKey: ORGANIZER }, COIN), size, amount, SEED);
  const ctx = RT.createCircuitContext({
    circuitId: 'enroll', contractAddress: ADDR, coinPublicKeyOrZswapState: COIN,
    contractState: ctor.currentContractState, privateState: { secretKey: ORGANIZER },
  });
  return { contract, ctx };
}

// Run `circuit` as the holder of `secretKey` and return the new context (plus proof data).
async function as(contract, ctx, circuit, secretKey, extra = {}, ...args) {
  const c = { ...ctx, callContext: { ...ctx.callContext, circuitId: circuit, currentPrivateState: { secretKey, ...extra } } };
  const r = await contract.impureCircuits[circuit](c, ...args);
  return r.context;
}

async function fullTanda() {
  const { contract, ctx } = await deploy();
  let c = ctx;
  for (const sk of [ANA, BETO, CARLA]) c = await as(contract, c, 'enroll', ORGANIZER, {}, pureCircuits.memberKey(sk));
  return { contract, c };
}

describe('Private Tanda', () => {
  it('starts with public rules and no members', async () => {
    const { ctx } = await deploy();
    const s = stateOf(ctx);
    expect(s.memberCount).toBe(3n);
    expect(s.contribution).toBe(AMOUNT);
    expect(s.enrolled).toBe(0n);
    expect(s.round).toBe(0n);
    expect(s.organizer).toHaveLength(32);
    expect(hex(s.organizer)).not.toBe(hex(ORGANIZER)); // only a hash of the organizer's key is public
  });

  it('rejects groups that are too small or too large', async () => {
    await expect(deploy(1n)).rejects.toThrow('A tanda needs at least 2 members');
    await expect(deploy(17n)).rejects.toThrow('A tanda can have at most 16 members');
    await expect(deploy(3n, 0n)).rejects.toThrow('The contribution must be positive');
  });

  it('only the organizer can enroll members', async () => {
    const { contract, ctx } = await deploy();
    await expect(as(contract, ctx, 'enroll', ANA, {}, pureCircuits.memberKey(ANA))).rejects.toThrow('Only the organizer can enroll members');
  });

  it('enrolls members in payout order and refuses duplicates and overflow', async () => {
    const { contract, ctx } = await deploy();
    let c = await as(contract, ctx, 'enroll', ORGANIZER, {}, pureCircuits.memberKey(ANA));
    await expect(as(contract, c, 'enroll', ORGANIZER, {}, pureCircuits.memberKey(ANA))).rejects.toThrow('This member is already enrolled');
    c = await as(contract, c, 'enroll', ORGANIZER, {}, pureCircuits.memberKey(BETO));
    c = await as(contract, c, 'enroll', ORGANIZER, {}, pureCircuits.memberKey(CARLA));
    const s = stateOf(c);
    expect(s.enrolled).toBe(3n);
    expect(hex(s.payoutOrder.lookup(0n))).toBe(hex(pureCircuits.memberKey(ANA)));
    expect(hex(s.payoutOrder.lookup(2n))).toBe(hex(pureCircuits.memberKey(CARLA)));
    await expect(as(contract, c, 'enroll', ORGANIZER, {}, pureCircuits.memberKey(OUTSIDER))).rejects.toThrow('The tanda is already full');
  });

  it('nobody can pay before the tanda is full', async () => {
    const { contract, ctx } = await deploy();
    const c = await as(contract, ctx, 'enroll', ORGANIZER, {}, pureCircuits.memberKey(ANA));
    await expect(as(contract, c, 'contribute', ANA)).rejects.toThrow('The tanda is not full yet');
  });

  it('a member pays without revealing who they are', async () => {
    const { contract, c } = await fullTanda();
    const paid = await as(contract, c, 'contribute', BETO);
    const s = stateOf(paid);
    expect(s.paidThisRound).toBe(1n);
    expect(s.nullifiers.size()).toBe(1n);
    const [nullifier] = [...s.nullifiers];
    // The nullifier is not any member's public key.
    for (const sk of [ANA, BETO, CARLA]) expect(hex(nullifier)).not.toBe(hex(pureCircuits.memberKey(sk)));
    // Nothing that identifies Beto appears in the public transcript of the call.
    const transcript = JSON.stringify(paid.callProofDataTrace.at(-1).publicTranscript, (k, v) => (v instanceof Uint8Array ? hex(v) : typeof v === 'bigint' ? v.toString() : v));
    // Positive control: the transcript does carry the public values (the nullifier), so the
    // checks below are meaningful and not passing on an empty or differently-encoded transcript.
    expect(transcript.length).toBeGreaterThan(100);
    expect(transcript.includes(hex(nullifier)) || JSON.stringify([...paid.callProofDataTrace.at(-1).publicTranscript].map(String)).includes(String(nullifier))).toBe(true);
    expect(transcript).not.toContain(hex(pureCircuits.memberKey(BETO)));
    expect(transcript).not.toContain(hex(BETO));
  });

  it('a member cannot pay twice in the same round', async () => {
    const { contract, c } = await fullTanda();
    const once = await as(contract, c, 'contribute', ANA);
    await expect(as(contract, once, 'contribute', ANA)).rejects.toThrow('You already paid this round');
  });

  it('an outsider cannot pay, even with a real member\'s Merkle path', async () => {
    const { contract, c } = await fullTanda();
    const anaPath = stateOf(c).members.findPathForLeaf(pureCircuits.memberKey(ANA));
    await expect(as(contract, c, 'contribute', OUTSIDER, { forgedPath: anaPath })).rejects.toThrow('The membership path is not for this member');
    await expect(as(contract, c, 'contribute', OUTSIDER)).rejects.toThrow(); // no path exists for an unknown key
  });

  it('the pot can only be collected when complete, and only by the member whose turn it is', async () => {
    const { contract, c } = await fullTanda();
    let x = await as(contract, c, 'contribute', ANA);
    x = await as(contract, x, 'contribute', BETO);
    await expect(as(contract, x, 'collect', ANA)).rejects.toThrow('The pot is not complete yet');
    x = await as(contract, x, 'contribute', CARLA);
    await expect(as(contract, x, 'collect', BETO)).rejects.toThrow('It is not your turn');
    await expect(as(contract, x, 'collect', OUTSIDER)).rejects.toThrow('It is not your turn');
    x = await as(contract, x, 'collect', ANA);
    const s = stateOf(x);
    expect(s.round).toBe(1n);
    expect(s.paidThisRound).toBe(0n);
  });

  it('runs a full 3-round tanda; each member collects once, in order, then it closes', async () => {
    const { contract, c } = await fullTanda();
    let x = c;
    const order = [ANA, BETO, CARLA];
    const tags = new Set();
    for (let r = 0; r < 3; r++) {
      tags.add(hex(stateOf(x).roundTag));
      for (const sk of [CARLA, ANA, BETO]) x = await as(contract, x, 'contribute', sk); // pay in any order
      x = await as(contract, x, 'collect', order[r]);
      expect(stateOf(x).round).toBe(BigInt(r + 1));
    }
    expect(tags.size).toBe(3); // a fresh round tag every round
    expect(stateOf(x).nullifiers.size()).toBe(9n); // 3 members x 3 rounds, all distinct
    await expect(as(contract, x, 'contribute', ANA)).rejects.toThrow('The tanda has finished');
    await expect(as(contract, x, 'collect', ANA)).rejects.toThrow('The tanda has finished');
  });

  it('a member\'s payments in different rounds are unlinkable', async () => {
    const { contract, c } = await fullTanda();
    let x = c;
    for (const sk of [ANA, BETO, CARLA]) x = await as(contract, x, 'contribute', sk);
    const round0 = new Set([...stateOf(x).nullifiers].map(hex));
    x = await as(contract, x, 'collect', ANA);
    x = await as(contract, x, 'contribute', ANA);
    const round1 = [...stateOf(x).nullifiers].map(hex).filter((n) => !round0.has(n));
    expect(round1).toHaveLength(1);
    expect(round0.has(round1[0])).toBe(false);
  });
});
