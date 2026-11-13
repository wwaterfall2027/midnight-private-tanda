# Private Tanda on Midnight

**A rotating savings circle where everyone can verify the pot is complete, but nobody can see who paid.**

A *tanda* (also called susu, chit fund, tontine, hui or ROSCA) is how hundreds of millions of people save: every round each member chips in, and one member takes the whole pot, in turns. Today it runs on trust and on a group chat where everyone sees who is late. That is a privacy problem: in small communities, "who hasn't paid yet" becomes gossip, pressure and sometimes shame.

**Private Tanda** keeps the useful part public (is the pot complete? whose turn is it?) and keeps the personal part private (who paid, and when).

Built for the Midnight Buildathon on AKINDO (Wave 3).

## What is public and what stays private

| Data | Where | Why |
|---|---|---|
| Number of members, amount per round | `sealed ledger` | Everyone must know the rules, and they can't change |
| Payout order | `ledger Map`, as anonymous member keys | Members need to know the order; the keys are hashes that reveal no identity |
| How many members paid this round | `ledger Counter` | The group must see when the pot is complete |
| **Which member paid** | **Never on chain** | Proven with a Merkle-tree membership proof that doesn't say which member |
| One nullifier per payment | `ledger Set` | Stops paying twice in a round; can't be linked to a member or across rounds |
| Each member's secret key | Witness, on the member's device | Only it can create that member's payments and collect their pot |

## How it works

```
enroll(memberKey)   organizer only. Adds the member's anonymous key to the Merkle tree and to
                    the payout order (position k collects in round k).
contribute()        any member. Proves "my key is a leaf of the members tree" (merkleTreePathRoot +
                    checkRoot) without revealing which leaf, then publishes
                    nullifier = hash("tanda:nullifier", roundTag, secretKey).
collect()           only when paid == members, and only by the member whose key is at
                    payoutOrder[round]. Advances the round and rotates roundTag.
```

The contract is [`contract/tanda.compact`](contract/tanda.compact): about 90 lines of Compact, 3 circuits.

### Why the privacy holds

- **Membership without identity.** `contribute` uses a `MerkleTree<4, Bytes<32>>`: the circuit proves knowledge of a path from the member's key to the published root. Per Midnight's docs, Merkle-tree membership is the one ledger operation that doesn't reveal *which* value is used.
- **Unlinkable nullifiers.** The nullifier hashes the member's *secret key* with a `roundTag` that changes every round. It isn't the member's public key, and the same member produces unrelated nullifiers in different rounds.
- **Bound proofs.** `assert(path.leaf == leaf)` binds the Merkle path to the caller's own key, so an outsider can't reuse a real member's path (this is tested).
- **Only the turn-holder collects.** `collect` compares the caller's key to `payoutOrder[round]`; the organizer can't redirect the pot.

## Tests

The CI compiles the contract with the official Compact toolchain **0.36.0** (ledger 9, `language_version` 0.28) and runs **11 tests** against the generated JavaScript with `@midnight-ntwrk/compact-runtime` **0.21.0**, the same logic the ZK circuits enforce:

- genesis state, and only a hash of the organizer key on chain;
- size and amount limits;
- only the organizer can enroll; duplicates and overflow are rejected;
- no payments before the group is full;
- **a payment's public transcript contains nothing that identifies the payer** (checked with a positive control: the transcript does contain the nullifier);
- no double payment in a round;
- an outsider can't pay, even with a real member's Merkle path;
- the pot can only be collected when complete, and only by the member whose turn it is;
- a full 3-member, 3-round tanda, with members paying in any order, 9 distinct nullifiers and a fresh round tag each round;
- a member's payments in different rounds are unlinkable.

Run them yourself: install the Compact toolchain, then `npm run compile && npm install && npm test`. Or see the **Compile and test** workflow in GitHub Actions.

## Scope and next steps

This wave delivers the privacy-critical core: membership, payments, ordering and payouts as contract state, fully tested. Next:

1. Move real value: attach a shielded token transfer to `contribute` and `collect`, following Midnight's private tip-jar pattern, so the pot is held as contract-owned coins.
2. A browser DApp with the Lace wallet, deployed on Preprod.
3. Optional collateral, so members who already collected keep paying, without revealing who is behind.

## License

MIT. Built with AI assistance (Claude Code).
