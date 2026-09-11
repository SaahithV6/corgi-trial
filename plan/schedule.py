"""
Reads graph.py, validates it, and answers four questions:

  1. Is it a DAG, and does every dependency exist?
  2. What is the critical path with unlimited workers? (the floor on wall clock)
  3. What actually happens with the real crew: one human who sleeps, one Claude,
     and N parallel subagents who do not?
  4. What is ready RIGHT NOW, ordered by how much slack it has?

The gap between (2) and (3) is the cost of resource contention, and it is the
number that tells us how many subagents to run.

Usage:  python3 schedule.py [--agents N] [--now "YYYY-MM-DD HH:MM"] [--sweep]
"""
import sys, argparse
from datetime import datetime, timedelta
from collections import defaultdict, Counter
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import graph

FMT = "%Y-%m-%d %H:%M"
T0 = datetime.strptime(graph.T0, FMT)
FREEZE = T0 + timedelta(hours=graph.FREEZE_HOURS)
BY = {n["id"]: n for n in graph.NODES}

# --------------------------------------------------------------------------- validate
def validate():
    errs = []
    for n in graph.NODES:
        for d in n["deps"]:
            if d not in BY:
                errs.append(f"{n['id']}: dependency {d!r} does not exist")
    # cycle detection, iterative Kahn
    indeg = {i: 0 for i in BY}
    for n in graph.NODES:
        for d in n["deps"]:
            if d in BY:
                indeg[n["id"]] += 1
    q = [i for i, v in indeg.items() if v == 0]
    seen, order = 0, []
    kids = defaultdict(list)
    for n in graph.NODES:
        for d in n["deps"]:
            if d in BY:
                kids[d].append(n["id"])
    while q:
        i = q.pop()
        order.append(i); seen += 1
        for k in kids[i]:
            indeg[k] -= 1
            if indeg[k] == 0:
                q.append(k)
    if seen != len(BY):
        stuck = sorted(set(BY) - set(order))
        errs.append(f"CYCLE involving: {stuck[:12]}")
    return errs, order

# --------------------------------------------------------------------------- CPM
def eff_dur(n):
    """Remaining cost of a node.

    A finished node costs nothing. Without this the critical path is computed
    over work that already shipped, so it reports a tour of the first evening
    of the trial and calls it the bottleneck -- confidently, and with a clean
    validation line above it. `simulate()` has always honoured status; `cpm()`
    did not, and the two disagreeing is worse than either being wrong alone,
    because the disagreement is invisible in the output.
    """
    return 0 if n["status"] in ("done", "cut") else n["dur"]

def cpm(order):
    """Earliest/latest start-finish with unlimited workers. Minutes from T0."""
    ES, EF = {}, {}
    for i in order:
        n = BY[i]
        ES[i] = max([EF[d] for d in n["deps"] if d in EF] or [0])
        EF[i] = ES[i] + eff_dur(n)
    horizon = max(EF.values())
    LF, LS = {}, {}
    kids = defaultdict(list)
    for n in graph.NODES:
        for d in n["deps"]:
            kids[d].append(n["id"])
    for i in reversed(order):
        n = BY[i]
        LF[i] = min([LS[k] for k in kids[i] if k in LS] or [horizon])
        LS[i] = LF[i] - eff_dur(n)
    slack = {i: LS[i] - ES[i] for i in order}
    # a done node has zero duration and therefore zero slack; it would
    # otherwise dominate the "zero slack" listing and hide the real path.
    slack = {i: (10**6 if BY[i]["status"] in ("done", "cut") else slack[i])
             for i in order}
    return ES, EF, LS, LF, slack, horizon

# --------------------------------------------------------------------------- resources
def awake(minute):
    """Is the human awake at T0+minute?"""
    t = (T0 + timedelta(minutes=minute)).time()
    for a, b in graph.HUMAN_SLEEP:
        a = datetime.strptime(a, "%H:%M").time()
        b = datetime.strptime(b, "%H:%M").time()
        if a <= b:
            if a <= t < b: return False
        else:
            if t >= a or t < b: return False
    return True

def next_awake(minute):
    m = minute
    for _ in range(3000):
        if awake(m): return m
        m += 5
    return m

DEADLINES = {"C01": 2*60, "C02": 24*60, "C03": 48*60}

def deadlines(order):
    """Tightest downstream gate deadline for every node.

    CPM slack is computed against the unlimited-worker horizon, so a node that
    feeds a mid-project gate can show enormous slack and get scheduled last.
    That is exactly how the T+24h checkpoint ended up 14 hours late on the
    first run. Real projects have interior deadlines; the scheduler has to see
    them."""
    kids = defaultdict(list)
    for n in graph.NODES:
        for d in n["deps"]:
            kids[d].append(n["id"])
    due = {i: DEADLINES.get(i, graph.FREEZE_HOURS*60) for i in order}
    for i in reversed(order):
        ds = [due[k] - BY[k]["dur"] for k in kids[i]]
        if ds:
            due[i] = min(due[i], min(ds))
    return due

def simulate(n_agents, slack, due=None, verbose=False):
    """Greedy list scheduler. Priority = least slack (critical path first)."""
    cap = {"human": 1, "claude": 1, "agent": n_agents}
    busy = {"human": 0, "claude": 0, "agent": 0}
    done, start, finish = {}, {}, {}
    running = []          # (finish_minute, id)
    files_held = Counter()
    pending = {n["id"] for n in graph.NODES if n["status"] != "cut"}
    for n in graph.NODES:
        if n["status"] == "done":
            start[n["id"]] = finish[n["id"]] = 0
            done[n["id"]] = True
            pending.discard(n["id"])
    t = 0
    guard = 0
    while pending and guard < 200000:
        guard += 1
        ready = [i for i in pending
                 if all(d in done for d in BY[i]["deps"])]
        ready.sort(key=lambda i: ((due or {}).get(i, 10**6) - t,
                                  slack.get(i, 0), -BY[i]["dur"]))
        launched = False
        for i in ready:
            n = BY[i]
            o = n["owner"]
            if busy[o] >= cap[o]:
                continue
            if o == "human":
                if not awake(t) or not awake(t + n["dur"] - 1):
                    continue
            # file collision against currently running work
            fs = n["files"]
            if "*" in fs:
                if files_held: continue
            elif any(files_held[f] for f in fs) or files_held["*"]:
                continue
            start[i] = t
            fin = t + n["dur"]
            finish[i] = fin
            running.append((fin, i))
            busy[o] += 1
            for f in fs: files_held[f] += 1
            pending.discard(i)
            launched = True
        if not pending: break
        if not running:
            # nothing runnable now; advance to next human wake if that is why
            t = next_awake(t + 5)
            continue
        if not launched or all(busy[o] >= cap[o] for o in cap) or True:
            running.sort()
            nt = running[0][0]
            while running and running[0][0] <= nt:
                fin, i = running.pop(0)
                done[i] = True
                busy[BY[i]["owner"]] -= 1
                for f in BY[i]["files"]: files_held[f] -= 1
            t = max(nt, t)
    makespan = max(finish.values()) if finish else 0
    return makespan, start, finish

# --------------------------------------------------------------------------- report
def clock(minute):
    return (T0 + timedelta(minutes=minute)).strftime("%a %H:%M")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agents", type=int, default=6)
    ap.add_argument("--now", default=None)
    ap.add_argument("--sweep", action="store_true")
    ap.add_argument("--waves", action="store_true")
    ap.add_argument("--no-delegate", action="store_true",
                    help="measure the counterfactual: everything claude-owned")
    a = ap.parse_args()

    if not a.no_delegate:
        graph.apply_delegation()
        globals()["BY"] = {n["id"]: n for n in graph.NODES}
    errs, order = validate()
    print(f"graph: {len(graph.NODES)} nodes, T0 {T0:%a %d %b %H:%M}, freeze {FREEZE:%a %d %b %H:%M}")
    if errs:
        print("\nVALIDATION ERRORS"); [print("  !", e) for e in errs]; sys.exit(1)
    print("validation: DAG ok, all deps resolve")

    ES, EF, LS, LF, slack, horizon = cpm(order)
    budget = graph.FREEZE_HOURS * 60
    total = sum(eff_dur(n) for n in graph.NODES)
    open_n = sum(1 for n in graph.NODES if n["status"] not in ("done", "cut"))
    print(f"\nwork REMAINING        {total/60:6.1f} h across {open_n} open nodes "
          f"({len(graph.NODES)} total, {len(graph.NODES) - open_n} done or cut)")
    print(f"critical path (inf)   {horizon/60:6.1f} h   <- floor, unlimited workers")
    print(f"budget to freeze      {budget/60:6.1f} h")

    crit = sorted([i for i in order if slack[i] == 0], key=lambda i: ES[i])
    print(f"\nCRITICAL PATH ({len(crit)} nodes, zero slack)")
    for i in crit:
        n = BY[i]
        print(f"  {clock(ES[i])}  {i:5s} {n['owner']:6s} {n['dur']:3d}m  {n['title'][:62]}")

    due = deadlines(order)
    if a.sweep:
        print("\nAGENT SWEEP  (makespan vs parallel subagents)")
        prev = None
        for k in (1,2,3,4,5,6,8,10,12,16):
            ms, _, _ = simulate(k, slack, due)
            d = "" if prev is None else f"  ({(prev-ms)/60:+.1f} h)"
            print(f"  {k:3d} agents -> {ms/60:6.1f} h{d}")
            prev = ms
        return

    ms, start, finish = simulate(a.agents, slack, due)
    print(f"\nSIMULATED with 1 human (sleeps {graph.HUMAN_SLEEP}), 1 claude, {a.agents} agents")
    print(f"  makespan            {ms/60:6.1f} h  -> finishes {clock(ms)}")
    print(f"  contention cost     {(ms-horizon)/60:6.1f} h over the unlimited-worker floor")
    over = ms - budget
    print(f"  vs freeze           {'OVER by %.1f h' % (over/60) if over>0 else 'INSIDE by %.1f h' % (-over/60)}")

    for gid in ("C02","C03"):
        if gid in finish:
            due = {"C02": 24*60, "C03": 48*60}[gid]
            fin = finish[gid]
            flag = "OK" if fin <= due else f"LATE by {(fin-due)/60:.1f} h"
            print(f"  gate {gid} finishes {clock(fin)} (due {clock(due)})  {flag}")

    print("\nHUMAN NODES ON THE CLOCK  (only Saahith can do these)")
    hum = sorted([n for n in graph.NODES if n["owner"]=="human" and n["status"]!="done"],
                 key=lambda n: start.get(n["id"], 0))
    for n in hum:
        i = n["id"]
        print(f"  {clock(start.get(i,0))}  {i:5s} {n['dur']:3d}m  {n['title'][:66]}")

    print("\nREADY NOW  (no unmet deps, least slack first)")
    ready = [i for i in order if BY[i]["status"] not in ("done","cut")
             and all(BY[d]["status"]=="done" for d in BY[i]["deps"])]
    ready.sort(key=lambda i: slack[i])
    for i in ready[:24]:
        n = BY[i]
        print(f"  slack {slack[i]/60:5.1f}h  {i:5s} {n['owner']:6s} {n['dur']:3d}m  {n['title'][:56]}")

    print("\nRISK NODES")
    for n in graph.NODES:
        if n["risk"]:
            print(f"  {n['id']:5s} {n['title'][:44]:46s} {n['risk'][:64]}")

if __name__ == "__main__":
    main()
