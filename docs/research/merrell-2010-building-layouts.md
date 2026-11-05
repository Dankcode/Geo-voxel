# Merrell, Schkufza & Koltun (2010) — Computer-Generated Residential Building Layouts

Cleaned digest and audit, written for Geo-voxel's per-building interior work. Paraphrased and restructured, not a
transcript: every equation, parameter and number from the paper is kept, but the figure-label clutter, running
heads, broken hyphenation and garbled math from the PDF extraction are removed.

- **Citation:** P. Merrell, E. Schkufza, V. Koltun. *Computer-Generated Residential Building Layouts.* ACM
  Transactions on Graphics 29(6) (Proc. SIGGRAPH Asia 2010). Stanford University.
- **Source PDF:** <https://paulmerrell.org/wp-content/uploads/2021/06/floorplan-final.pdf> (11 pages, pdfTeX
  2010-09-02 author copy).
- **Related in this repo:** the engine's repair pass already credits Merrell's *model synthesis* (a different paper,
  same first author); `docs/ENGINE.md`.

---

## 1. What the paper does, in one paragraph

You give it a few high-level requirements (bedrooms, bathrooms, floors, square footage). A **Bayesian network**
trained on 120 real house plans expands them into a full **architectural program**: every room, its target area and
aspect ratio, and which rooms connect (by a door or an open wall). **Metropolis (MCMC) optimization** then lays out
rectilinear floor plans for every storey at once that realize that program. Finally a **style template** turns the
plans into a 3D house with doors, windows, stairs and a straight-skeleton roof. It mirrors how residential architects
work: requirements → bubble diagram → schematic plan → detailed plan.

## 2. The architect's process the method copies (§3)

1. Expand vague client requirements into a list of rooms and adjacencies ("adjacency" = direct access: a door or an
   open wall). Architects sketch this as a **bubble diagram** (rooms = blobs, adjacencies = edges).
2. Iterate floor by floor until it becomes the **architectural program**: every space on every floor, its
   adjacencies, its rough size; multi-storey spaces (stairwells, atria) marked.
3. **Schematic plan**: a rough planar arrangement where adjacent rooms touch and sizes are roughly right ("assembling
   a puzzle").
4. **Detailed plan**: walls pinned down; doors, windows and open walls placed.
5. Exterior style is treated as largely independent of the layout and applied last.

Two rules of thumb are near-universal and drive the cost function:

- **Privacy gradient** — public rooms (living room) near the entrance, private rooms (bedrooms) far from it.
- **Convex rooms** — avoid deep recesses; concave rooms feel uncomfortable.

## 3. Stage 1 — Architectural program from a Bayesian network (§4)

### Why a graphical model

Sampling each room type and each adjacency independently produces implausible programs: bedroom–bath and
kitchen–bath are both common, so independent sampling yields kitchen→bath→bedroom paths, which real plans almost
never have. A Bayesian network captures the conditional dependencies (e.g. 3+ bedrooms makes a separate dining room
more likely).

### Features recorded per training plan

| Feature | Domain |
|---|---|
| Total square footage | integer (quantized) |
| Bounding footprint | integer × integer |
| Room type | {bed, bath, kitchen, …} |
| Per-room area | integer (quantized) |
| Per-room aspect ratio (of bounding rectangle) | integer × integer |
| Room–room adjacency exists | {true, false} |
| Room–room adjacency type | {open wall, door} |

The network holds existence nodes per room slot (several for repeatable types like bedrooms), area and aspect nodes
per room, and existence and type nodes per room pair.

### Conditioning

Any subset of variables can be fixed as the requirements (bedroom count, total area, the area of a particular room…).
The rest are sampled; the conditional distributions come from the **junction tree** algorithm.

### Training

- Data: **120 programs hand-encoded** from one plan catalogue (Wood 2007, *Essential House Plan Collection*).
  Continuous values are quantized.
- **Separate networks by number of storeys**, since a single network with hidden variables would need too much data:

| Network | Training plans | Nodes | Edges | Training time |
|---|---|---|---|---|
| Single-story | 40 | 42 | 33 | 1,452 s |
| Two-story | 50 | 82 | 61 | 4,407 s |
| Three-story | 30 | 120 | 92 | 8,293 s |

  (Intel Pentium D 2.8 GHz; Intel's open-source Probabilistic Networks Library.)
- **Structure search:** greedy local search adding, removing or flipping one edge at a time, maximizing the Bayesian
  score

  $$\log p(D, S^h) = \log p(D \mid S^h) + \log p(S^h)$$

  with a uniform structure prior and the marginal likelihood approximated by BIC (Heckerman 1999).
- **Aspect-ratio nodes are left out of structure learning** and attached afterwards, each to its own room's area
  node, which shrinks the search.
- Quality vs. training: after 10 iterations, programs contain implausible cliques; after 100 they can lack a kitchen;
  after 1,000 they look plausible and follow the privacy gradient.

## 4. Stage 2 — Floor-plan optimization (§5)

### Search method

The number of wall segments varies between layouts that realize the same program, so the search space has variable
dimension, which rules out fixed-dimension optimizers such as CMA-ES. Reversible-jump MCMC worked but was complicated;
plain **Metropolis** (as used in VLSI layout) was sufficient. Every storey is optimized jointly.

Objective and acceptance rule:

$$f(x) = e^{-\beta C(x)}, \qquad
\alpha(x^\star \mid x) = \min\!\left(1, \frac{f(x^\star)}{f(x)}\right) = \min\!\left(1,\ e^{\beta\,(C(x) - C(x^\star))}\right)$$

- **Start state:** a deliberately bad canonical layout with equal-size rectangular rooms packed on a grid on each floor.
- **β:** a fixed value works; annealing β over time explores faster (White 1984).
- **Cost of one run:** the illustrated example took 35 s (Core i7 3.2 GHz) and ran on the order of 10⁵ iterations
  (figures show 200 / 2,000 / 20,000 / 100,000). Whole models took a few seconds to 7 minutes, single-threaded.

### Representation

A floor plan is a set of *n* rooms, each a **rectilinear polygon** bounded by wall segments. A **wall** is a maximal
contiguous run of collinear wall segments.

### Proposal moves (§5.1)

Any layout with the same number of rooms can reach any other using these moves:

1. **Slide a wall.** Pick a wall and a split point on it, split it into two collinear walls, keep one in place and
   move the other perpendicular by $d \sim \mathcal N(0, \sigma^2)$.
   - The split point lands on an existing vertex or endpoint with positive probability (an endpoint means the whole
     wall moves). Splitting mid-segment is allowed and is what creates concave corners, which many programs need.
   - **Snap:** if the moved wall ends within ε of another wall, snap it there. Also snap to walls on neighbouring
     floors to keep storeys consistent.
   - Constants: **ε = 1 ft, σ = 2ε**.
2. **Swap two rooms.** Two random rooms exchange labels: a big jump that the slide moves then repair.

### Cost function (§5.2)

$$C(x) = k_a C_a(x) + k_d C_d(x) + k_f C_f(x) + k_s C_s(x)$$

**Accessibility $C_a$.** The number of required connections that cannot be made (two rooms must share a wall long
enough for a door), plus the number of entrances, patios and garages that have no access to the outside. This term
carries both circulation and the privacy gradient.

**Dimensions $C_d$.** Instead of one sampled area and aspect per room, keep the full distribution the network gives
for each, and penalize unlikely values:

$$C_d(x) = -\sum_{i=1}^{n} \left(\ell^i_{a}(x) + \ell^i_{as}(x)\right)$$

where $\ell^i_a$ and $\ell^i_{as}$ are the log-likelihoods of room *i*'s current area and aspect ratio.

**Floors $C_f$.** Each floor must sit within the envelope of the floor below; the ground floor must sit inside the
lot $F^0_x$. With $F^i_x$ the union of rooms on floor *i* and $A(\cdot)$ area:

$$C_f(x) = \frac{\sum_{i=1}^{l} A\!\left(F^i_x - F^{i-1}_x\right)}{\sum_{i=1}^{l} A\!\left(F^i_x\right)}$$

**Shapes $C_s$.** Convexity deficit plus an edge-count regularizer, for a shape *S* with convex hull *H(S)* and *e(S)*
edges on its outline:

$$M_c(S) = \frac{A(H(S)) - A(S)}{A(S)} + e(S)$$

Hallways and stairways ($h_i = 1$) are exempt, since they are walked through rather than lived in. Rooms joined by
open walls form groups $G^i_x$ that are judged as one space. The floor outlines are penalized for irregularity:

$$C_s(x) = k_r \sum_{i=1}^{n} (1 - h_i)\, M_c(R^i_x) + k_g \sum_{i=1}^{g} M_c(G^i_x) + k_o \sum_{i=1}^{l} e(F^i_x)$$

Ablations: drop accessibility and connections break; drop area and room sizes drift; drop aspect and rooms become
slivers; drop shape and rooms and outlines become ragged.

## 5. Stage 3 — 3D model generation (§6)

A **style template** lists the geometry and material of every element (windows, doors, wall segments, gables,
stairs, roofs, patio poles, banisters), plus window and banister spacing, roof angle, whether there are gables, and
roof overhang. Adding a style means adding a template; the paper shows Cottage, Italianate, Tudor and Craftsman.

- **Passageways by privacy:** ordinary doors for private rooms (bedrooms), glazed French doors for semi-private rooms
  (studies, patios), wide openings between public rooms. Where floor levels differ (a gallery above a two-storey
  living room) a banister replaces the opening.
- **Door position:** near corners, never mid-wall (Alexander: a mid-wall door splits a room in two). Choose the spot
  that minimizes the summed distance to the nearest corner in each of the two rooms.
- **Windows:** at regular intervals along each room's exterior walls, sized and styled per room type from the
  template. If a lower roof is in the way, fall back to a smaller window type or none. The entrance room's central
  window becomes the front door.
- **Stairs:** shaped by the stair space: narrow rectangle → straight run; room for two flights → U-shape; L-shaped
  space → 90° turn. Step width ≥ 36 in, tread 9–11 in, riser ≤ 8¼ in (AIA *Architectural Graphic Standards*).
- **Roofs:** straight skeleton → hipped roof; gables (if the style asks for them) by projecting a roof face's
  vertices onto the facade plane, except faces with horizontal top edges.

## 6. Results and stated limits (§7–8)

- Given an architect's program, the optimizer produces a layout comparable to the architect's (Fig. 11). Generated
  plans sit next to catalogue plans in Fig. 12.
- **Failures:** sometimes the optimizer stops before $C_a = 0$ (e.g. a blocked staircase). That is easy to detect.
  Rates: almost never for one storey, about **1 in 20** for two storeys, **1 in 5** for three. The cause is spaces
  that span floors (stairs, double-height rooms) and couple the floors.
- The three-storey training plans are hillside houses (entry level, a lower level with its own outdoor access, an
  upper level), so the three-storey model expects a slope.
- Furniture in the renders was **placed by hand**.
- **Stated limits and future work:** residential only; no site, climate, view or client factors (could be added as
  cost terms); apartments and offices probably don't need floors coupled because their floors repeat; interactive
  editing; data-driven furniture and outdoor layout; non-rectilinear and curved walls; varying floor and ceiling
  heights; tighter coupling with the facade.

---

## 7. Audit

### Holds up

- The pipeline is internally consistent: training-set sizes (40 + 50 + 30 = 120) match the stated corpus, every cost
  term is defined and ablated, and the failure mode is reported with rates.
- The core idea carries over to us: **sample a program, then optimize a plan against a cost**. The separable cost
  terms map cleanly onto a voxel grid.
- Being honest that convergence to the global optimum is guaranteed only in theory (Geman & Geman), with explicit
  failure detection, is the right design for a generator. We should keep a gate-and-retry loop.

### Gaps and things we cannot reproduce

1. **No data release.** The 120 encoded programs and the learned networks were never published, so Stage 1 can't be
   reproduced as described. We need our own priors (hand-authored conditional tables, or a learned model trained on a
   floor-plan dataset whose licence allows it).
2. **Missing constants.** $k_a, k_d, k_f, k_s, k_r, k_g, k_o$, β and the annealing schedule are never given, nor are
   the iteration count or stopping rule (only "about 10⁵ iterations" can be read off the figures). Expect to tune them.
3. **Small, narrow corpus.** One US plan catalogue: suburban detached houses in imperial units. Nothing on terraces,
   shop units, apartments, offices or civic buildings, which make up most of a real downtown map.
4. **It designs the outline, we don't.** The paper only requires the plan to fit inside the lot ($C_f$ against
   $F^0$), and it penalizes ragged outlines ($k_o$). On a real map the outline **is** the OSM footprint and it is
   fixed. Our problem is the harder one: partition a given rectilinear outline, keep doors and windows off party
   walls, and put the entrance on the street side.
5. **Cost-function edge cases.** $C_a$ is a flat count: one missing connection that cuts a wing off from the
   entrance costs the same as one missing redundant loop (we add a separate reachability term). $C_s$ adds e(S) as a raw edge count
   to a dimensionless ratio, so its weight depends on units and room size. $C_f$ is a support constraint, not a
   wall-stacking one: nothing stacks bathrooms or kitchens, or lines up partitions between floors, beyond the
   snap-to-neighbouring-floor move.
6. **The move set never changes room count.** It can't add or remove a room when the program doesn't fit the
   envelope. On a fixed footprint that matters more; we need a program-repair step (drop the lowest-priority room and
   resample).
7. **Speed.** About 35 s to 7 min per house, single-threaded. A Geo-voxel map has tens to hundreds of buildings and is
   built in a browser worker in seconds, so we need a budget of roughly 10²–10³ ms per building. That is feasible
   because our grids are small (about 0.9 m cells) and the outline is fixed, but it has to be designed for.
8. **Evaluation is visual only.** No user study and no quantitative comparison with the catalogue plans beyond
   side-by-side figures.
9. **Typos (none affect the method):** "Singe-story" (§4.2), "Commununications" (Galle ref.), "highlevel".

### Later work worth knowing (not in the paper)

- Bao, Yan, Mitra, Wonka — *Generating and exploring good building layouts* (SIGGRAPH 2013): exploring the space of
  good layouts under constraints.
- Wu et al. — *MIQP-based layout design for building interiors* (Eurographics 2018): exact optimization of a plan
  **inside a given boundary**, which is our fixed-outline case.
- Wu et al. — *Data-driven interior plan generation for residential buildings* (SIGGRAPH Asia 2019) and the RPLAN
  dataset (~80k plans; check the licence before using it); Graph2Plan (2020); House-GAN / House-GAN++ (2020–21):
  learned programs and plans conditioned on a boundary.

## 8. What Geo-voxel takes from it

| Paper | Geo-voxel adaptation |
|---|---|
| Requirements → Bayesian network program | Map data → conditional program sampler (use, area, storeys, tenants, frontage, entrances) |
| Lot $F^0$, free outline | **Fixed** footprint per storey (rectified OSM outline, party walls, street sides) |
| Metropolis, slide-wall + swap moves | Same, on the 0.9 m cell lattice: walls on cell lines, ε = 1 cell, σ = 2 cells |
| $C_a, C_d, C_f, C_s$ | $C_a$ + reachability + street entry; $C_d$ in m²; $C_f$ → wall/wet/stair stacking; $C_s$ without $k_o$; plus a daylight term |
| Door types by privacy, doors near corners | Map onto the engine's open pairs / doors / locked doors; move doors off wall midpoints |
| Stair shape from stair space | Straight / U / L runs in a stair room stacked on every storey |
| Failure detection | Gate → reseed → fall back to today's `planRows`, recorded in the build report |

The full implementation plan is in `docs/plans/PLAN-geo-interiors-01.md`.
