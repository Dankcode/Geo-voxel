// Deterministic graph Wave Function Collapse.
//
// This is a small constraint solver, not a visual-only randomizer. Every declared directed
// adjacency is propagated in both directions, domains and fixed values are validated up front,
// and a result is returned only after every constraint has been checked. JSON-derived priors are
// weights, never hard-coded answers, so the same solver can compose districts, buildings and
// facade modules without silently accepting an impossible world.

const MAX_BACKTRACKS = 200000;

export class WaveFunctionCollapseError extends Error {
    constructor(message, code = 'WFC_CONTRADICTION', details = {}) {
        super(message);
        this.name = 'WaveFunctionCollapseError';
        this.code = code;
        this.details = details;
    }
}

export function hashWaveSeed(value) {
    let hash = 2166136261;
    const text = String(value);
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function createWaveRandom(seed) {
    let state = hashWaveSeed(seed) || 1;
    return () => {
        state |= 0;
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function solveWaveFunctionCollapse({
    nodes = [],
    tiles = [],
    compatible = () => true,
    fixed = new Map(),
    seed = 'wave',
    nodeWeights = null,
    domains: initialDomains = null
} = {}) {
    if (!Array.isArray(nodes) || !Array.isArray(tiles)) {
        throw new WaveFunctionCollapseError('nodes and tiles must be arrays.', 'WFC_INVALID_INPUT');
    }
    if (nodes.length === 0) return new Map();
    if (tiles.length === 0) {
        throw new WaveFunctionCollapseError('A non-empty graph requires at least one tile.', 'WFC_EMPTY_TILESET');
    }
    if (typeof compatible !== 'function') {
        throw new WaveFunctionCollapseError('compatible must be a function.', 'WFC_INVALID_INPUT');
    }

    const model = createConstraintModel({
        nodes,
        tiles,
        compatible,
        fixed,
        seed,
        nodeWeights,
        initialDomains
    });
    const propagated = propagateDomains(model.domains, model, model.nodeIds);
    if (!propagated) {
        throw new WaveFunctionCollapseError('The initial WFC constraints are contradictory.', 'WFC_CONTRADICTION');
    }

    const searchState = { backtracks: 0 };
    const solved = searchWave(propagated, model, searchState);
    if (!solved) {
        throw new WaveFunctionCollapseError('No assignment satisfies the WFC constraints.', 'WFC_UNSATISFIABLE', {
            backtracks: searchState.backtracks
        });
    }

    const assignment = new Map();
    for (const nodeId of model.nodeIds) {
        const domain = solved.get(nodeId);
        if (!domain || domain.size !== 1) {
            throw new WaveFunctionCollapseError('WFC finished with an unresolved node.', 'WFC_INTERNAL_ERROR', { nodeId });
        }
        assignment.set(nodeId, domain.values().next().value);
    }
    validateAssignment(assignment, model);
    return assignment;
}

// Validate an externally produced assignment against the same contract as the solver. Terrain
// generators can use this at chunk boundaries before committing a locally generated result.
// A valid assignment covers exactly the declared nodes and honors tile, domain, fixed-value and
// directed adjacency constraints. Invalid assignments throw the same typed error as the solver.
export function validateWaveAssignment({
    assignment,
    nodes = [],
    tiles = [],
    compatible = () => true,
    fixed = new Map(),
    domains: initialDomains = null
} = {}) {
    if (!Array.isArray(nodes) || !Array.isArray(tiles)) {
        throw new WaveFunctionCollapseError('nodes and tiles must be arrays.', 'WFC_INVALID_INPUT');
    }
    if (nodes.length > 0 && tiles.length === 0) {
        throw new WaveFunctionCollapseError('A non-empty graph requires at least one tile.', 'WFC_EMPTY_TILESET');
    }
    if (typeof compatible !== 'function') {
        throw new WaveFunctionCollapseError('compatible must be a function.', 'WFC_INVALID_INPUT');
    }
    if (!assignment
        || typeof assignment.get !== 'function'
        || typeof assignment.has !== 'function'
        || typeof assignment.keys !== 'function') {
        throw new WaveFunctionCollapseError('assignment must be a Map-like value.', 'WFC_INVALID_ASSIGNMENT');
    }

    const model = createConstraintModel({
        nodes,
        tiles,
        compatible,
        fixed,
        seed: 'validation',
        nodeWeights: null,
        initialDomains
    });
    validateAssignment(assignment, model);
    return true;
}

function createConstraintModel({ nodes, tiles, compatible, fixed, seed, nodeWeights, initialDomains }) {
    const nodeById = new Map();
    for (const node of nodes) {
        if (!node || node.id === undefined || node.id === null) {
            throw new WaveFunctionCollapseError('Every node must have an id.', 'WFC_INVALID_NODE');
        }
        if (nodeById.has(node.id)) {
            throw new WaveFunctionCollapseError(`Duplicate node id "${String(node.id)}".`, 'WFC_DUPLICATE_NODE', { nodeId: node.id });
        }
        nodeById.set(node.id, node);
    }

    const tileById = new Map();
    const baseWeight = new Map();
    for (const tile of tiles) {
        if (!tile || tile.id === undefined || tile.id === null) {
            throw new WaveFunctionCollapseError('Every tile must have an id.', 'WFC_INVALID_TILE');
        }
        if (tileById.has(tile.id)) {
            throw new WaveFunctionCollapseError(`Duplicate tile id "${String(tile.id)}".`, 'WFC_DUPLICATE_TILE', { tileId: tile.id });
        }
        const weight = tile.weight === undefined ? 1 : Number(tile.weight);
        if (!Number.isFinite(weight) || weight < 0) {
            throw new WaveFunctionCollapseError(`Tile "${String(tile.id)}" has an invalid weight.`, 'WFC_INVALID_WEIGHT', { tileId: tile.id });
        }
        tileById.set(tile.id, tile);
        baseWeight.set(tile.id, weight);
    }

    const nodeIds = [...nodeById.keys()].sort(compareIds);
    const tileIds = [...tileById.keys()].sort(compareIds);
    const domains = new Map();
    for (const nodeId of nodeIds) {
        let allowed = tileIds;
        if (initialDomains?.has?.(nodeId)) {
            const raw = initialDomains.get(nodeId);
            if (raw === null || raw === undefined || typeof raw[Symbol.iterator] !== 'function') {
                throw new WaveFunctionCollapseError('A node domain must be an iterable.', 'WFC_INVALID_DOMAIN', { nodeId });
            }
            allowed = [...new Set(raw)].sort(compareIds);
            if (allowed.length === 0) {
                throw new WaveFunctionCollapseError('A node domain cannot be empty.', 'WFC_EMPTY_DOMAIN', { nodeId });
            }
            for (const tileId of allowed) {
                if (!tileById.has(tileId)) {
                    throw new WaveFunctionCollapseError('A node domain references an unknown tile.', 'WFC_UNKNOWN_TILE', { nodeId, tileId });
                }
            }
        }
        domains.set(nodeId, new Set(allowed));
    }

    // Keep the declared domains separate from the mutable domains used by propagation. Fixed
    // values narrow the search domains, but both constraints are reported independently when a
    // caller validates an externally generated assignment.
    const allowedDomains = cloneDomains(domains);

    const fixedEntries = fixed?.entries ? [...fixed.entries()] : [];
    for (const [nodeId, tileId] of fixedEntries) {
        if (!nodeById.has(nodeId)) {
            throw new WaveFunctionCollapseError('A fixed assignment references an unknown node.', 'WFC_UNKNOWN_NODE', { nodeId });
        }
        if (!tileById.has(tileId)) {
            throw new WaveFunctionCollapseError('A fixed assignment references an unknown tile.', 'WFC_UNKNOWN_TILE', { nodeId, tileId });
        }
        if (!domains.get(nodeId).has(tileId)) {
            throw new WaveFunctionCollapseError('A fixed tile is outside the node domain.', 'WFC_FIXED_OUTSIDE_DOMAIN', { nodeId, tileId });
        }
        domains.set(nodeId, new Set([tileId]));
    }

    const constraints = [];
    const relationsByNode = new Map(nodeIds.map((id) => [id, []]));
    const seenConstraints = new Set();
    for (const nodeId of nodeIds) {
        const node = nodeById.get(nodeId);
        const neighbors = Array.isArray(node.neighbors) ? [...node.neighbors] : [];
        neighbors.sort((a, b) => compareIds(a?.id, b?.id) || String(a?.direction || '').localeCompare(String(b?.direction || '')));
        for (const neighbor of neighbors) {
            if (!neighbor || !nodeById.has(neighbor.id)) {
                throw new WaveFunctionCollapseError('A constraint references an unknown neighboring node.', 'WFC_UNKNOWN_NEIGHBOR', {
                    nodeId,
                    neighborId: neighbor?.id
                });
            }
            if (neighbor.id === nodeId) continue;
            const signature = `${canonicalId(nodeId)}>${canonicalId(neighbor.id)}:${String(neighbor.direction ?? '')}`;
            if (seenConstraints.has(signature)) continue;
            seenConstraints.add(signature);
            const relation = { source: nodeId, target: neighbor.id, direction: neighbor.direction };
            constraints.push(relation);
            relationsByNode.get(nodeId).push(relation);
            relationsByNode.get(neighbor.id).push(relation);
        }
    }

    const weightOf = (nodeId, tileId) => {
        const override = nodeWeights ? nodeWeights(nodeId, tileId) : undefined;
        const weight = override === undefined || override === null ? baseWeight.get(tileId) : Number(override);
        if (!Number.isFinite(weight) || weight < 0) {
            throw new WaveFunctionCollapseError('A node-specific weight is invalid.', 'WFC_INVALID_WEIGHT', { nodeId, tileId });
        }
        return weight;
    };

    return {
        nodeIds,
        tileIds,
        nodeById,
        tileById,
        domains,
        constraints,
        relationsByNode,
        compatible,
        seed: String(seed),
        weightOf,
        allowedDomains,
        fixedAssignments: new Map(fixedEntries)
    };
}

function searchWave(domains, model, state) {
    const nodeId = selectEntropyNode(domains, model);
    if (nodeId === null) return domains;
    if (state.backtracks >= MAX_BACKTRACKS) {
        throw new WaveFunctionCollapseError('WFC exceeded its deterministic backtracking budget.', 'WFC_BACKTRACK_LIMIT', {
            maxBacktracks: MAX_BACKTRACKS
        });
    }

    const options = orderDomainOptions(nodeId, domains.get(nodeId), model);
    for (const tileId of options) {
        const next = cloneDomains(domains);
        next.set(nodeId, new Set([tileId]));
        const propagated = propagateDomains(next, model, [nodeId]);
        if (propagated) {
            const solved = searchWave(propagated, model, state);
            if (solved) return solved;
        }
        state.backtracks += 1;
    }
    return null;
}

function propagateDomains(domains, model, initialNodeIds) {
    const queue = [...new Set(initialNodeIds)].sort(compareIds);
    const queued = new Set(queue);
    while (queue.length > 0) {
        const changedNode = queue.shift();
        queued.delete(changedNode);
        for (const relation of model.relationsByNode.get(changedNode) || []) {
            const revisedNode = relation.source === changedNode ? relation.target : relation.source;
            if (!reviseDomain(revisedNode, relation, domains, model)) continue;
            if (domains.get(revisedNode).size === 0) return null;
            if (!queued.has(revisedNode)) {
                queue.push(revisedNode);
                queue.sort(compareIds);
                queued.add(revisedNode);
            }
        }
    }
    return domains;
}

function reviseDomain(nodeId, relation, domains, model) {
    const domain = domains.get(nodeId);
    const otherId = relation.source === nodeId ? relation.target : relation.source;
    const otherDomain = domains.get(otherId);
    let changed = false;
    for (const tileId of [...domain]) {
        const supported = [...otherDomain].some((otherTileId) => relation.source === nodeId
            ? model.compatible(tileId, otherTileId, relation.direction, relation.source, relation.target)
            : model.compatible(otherTileId, tileId, relation.direction, relation.source, relation.target));
        if (supported) continue;
        domain.delete(tileId);
        changed = true;
    }
    return changed;
}

function selectEntropyNode(domains, model) {
    let best = null;
    let bestScore = Infinity;
    for (const nodeId of model.nodeIds) {
        const domain = domains.get(nodeId);
        if (domain.size <= 1) continue;
        const weights = [...domain].map((tileId) => model.weightOf(nodeId, tileId));
        const positiveTotal = weights.reduce((sum, weight) => sum + weight, 0);
        const effective = positiveTotal > 0 ? weights : weights.map(() => 1);
        const total = effective.reduce((sum, weight) => sum + weight, 0);
        const weightedLog = effective.reduce((sum, weight) => sum + (weight > 0 ? weight * Math.log(weight) : 0), 0);
        const entropy = Math.log(total) - weightedLog / total;
        const signature = [...domain].sort(compareIds).map(canonicalId).join('|');
        const jitter = keyedUnit(`${model.seed}:entropy:${canonicalId(nodeId)}:${signature}`) * 1e-6;
        const score = entropy + jitter;
        if (score < bestScore) {
            bestScore = score;
            best = nodeId;
        }
    }
    return best;
}

function orderDomainOptions(nodeId, domain, model) {
    const signature = [...domain].sort(compareIds).map(canonicalId).join('|');
    const weights = [...domain].map((tileId) => model.weightOf(nodeId, tileId));
    const hasPositive = weights.some((weight) => weight > 0);
    return [...domain].sort((a, b) => {
        const weightA = model.weightOf(nodeId, a);
        const weightB = model.weightOf(nodeId, b);
        const unitA = Math.max(Number.EPSILON, keyedUnit(`${model.seed}:choice:${canonicalId(nodeId)}:${signature}:${canonicalId(a)}`));
        const unitB = Math.max(Number.EPSILON, keyedUnit(`${model.seed}:choice:${canonicalId(nodeId)}:${signature}:${canonicalId(b)}`));
        const scoreA = hasPositive && weightA <= 0 ? Infinity : -Math.log(unitA) / (hasPositive ? weightA : 1);
        const scoreB = hasPositive && weightB <= 0 ? Infinity : -Math.log(unitB) / (hasPositive ? weightB : 1);
        return scoreA - scoreB || compareIds(a, b);
    });
}

function validateAssignment(assignment, model) {
    for (const nodeId of assignment.keys()) {
        if (!model.nodeById.has(nodeId)) {
            throw new WaveFunctionCollapseError('The final assignment contains an unknown node.', 'WFC_INVALID_RESULT', {
                nodeId,
                reason: 'unknown-node'
            });
        }
    }
    for (const nodeId of model.nodeIds) {
        if (!assignment.has(nodeId)) {
            throw new WaveFunctionCollapseError('The final assignment is missing a node.', 'WFC_INVALID_RESULT', {
                nodeId,
                reason: 'missing-node'
            });
        }
        const tileId = assignment.get(nodeId);
        if (!model.tileById.has(tileId)) {
            throw new WaveFunctionCollapseError('The final assignment references an unknown tile.', 'WFC_INVALID_RESULT', {
                nodeId,
                tileId,
                reason: 'unknown-tile'
            });
        }
        if (!model.allowedDomains.get(nodeId).has(tileId)) {
            throw new WaveFunctionCollapseError('The final assignment violates a node domain.', 'WFC_INVALID_RESULT', {
                nodeId,
                tileId,
                reason: 'domain'
            });
        }
        if (model.fixedAssignments.has(nodeId) && model.fixedAssignments.get(nodeId) !== tileId) {
            throw new WaveFunctionCollapseError('The final assignment violates a fixed value.', 'WFC_INVALID_RESULT', {
                nodeId,
                tileId,
                expectedTileId: model.fixedAssignments.get(nodeId),
                reason: 'fixed'
            });
        }
    }
    for (const relation of model.constraints) {
        const sourceTile = assignment.get(relation.source);
        const targetTile = assignment.get(relation.target);
        if (!model.compatible(sourceTile, targetTile, relation.direction, relation.source, relation.target)) {
            throw new WaveFunctionCollapseError('The final assignment violates an adjacency constraint.', 'WFC_INVALID_RESULT', {
                source: relation.source,
                target: relation.target,
                sourceTile,
                targetTile,
                direction: relation.direction,
                reason: 'adjacency'
            });
        }
    }
    return true;
}

function cloneDomains(domains) {
    return new Map([...domains].map(([nodeId, domain]) => [nodeId, new Set(domain)]));
}

function keyedUnit(value) {
    return (hashWaveSeed(value) + 0.5) / 4294967296;
}

function canonicalId(value) {
    return `${typeof value}:${String(value)}`;
}

function compareIds(a, b) {
    return canonicalId(a).localeCompare(canonicalId(b));
}

// Facade wave: perimeter slots form a graph; fixed corners and door flanks remain walls and no
// two window panels may touch. The same building seed always resolves to the same facade.
export const FACADE_TILES = Object.freeze([
    { id: 'window', weight: 1.0 },
    { id: 'wall', weight: 1.35 }
]);

export function facadeCompatible(tileA, tileB) {
    return !(tileA === 'window' && tileB === 'window');
}

export function solveFacadeWave({ slots = [], fixedWalls = [], seed = 'facade' } = {}) {
    const slotIds = new Set(slots.map((slot) => slot.id));
    const nodes = slots.map((slot) => ({
        id: slot.id,
        neighbors: (slot.neighbors || [])
            .filter((neighborId) => slotIds.has(neighborId))
            .map((neighborId) => ({ id: neighborId, direction: 'ring' }))
    }));
    const fixed = new Map(fixedWalls.filter((id) => slotIds.has(id)).map((id) => [id, 'wall']));
    return solveWaveFunctionCollapse({
        nodes,
        tiles: FACADE_TILES,
        compatible: facadeCompatible,
        fixed,
        seed
    });
}
