/**
 * Depgraph Core Types (JSDoc)
 *
 * Two primitives: Node and Edge. Everything else is derived.
 * See SPEC.md §3 for the data model.
 */

// ─── Primitives ───

/**
 * @typedef {Object} Node
 * @property {string} id
 * @property {string} kind - e.g. 'function', 'global', 'cluster', 'user-action', 'parameter', 'value'
 * @property {string} label
 * @property {number} importance - producer-assigned relevance (default 1)
 * @property {number} [minZoom] - legacy; fractal LOD replaces this
 */

/**
 * @typedef {Object} Edge
 * @property {string} id - canonical form: `source→target@layer`
 * @property {string} source
 * @property {string} target
 * @property {string} layer - e.g. 'calls', 'memberOf', 'shared', 'sharedName', 'spatial'
 * @property {number} weight
 * @property {boolean} directed
 * @property {string} [label]
 * @property {number} [stretch] - free scalar in ℝ, default 0. Target edge length
 *   is BASE_DIST * exp(stretch). Positive stretches the spring (expand);
 *   negative contracts it (collapse). Engine accepts any value; UI caps for sanity.
 */

// ─── History ───

/**
 * @typedef {Object} HistoryRow
 * @property {number} t - monotonic timestamp (event order / replay cursor)
 * @property {'NODE'|'EDGE'} type
 * @property {'add'|'update'|'remove'} op
 * @property {string} id
 * @property {string} [kind]
 * @property {string} [source]
 * @property {string} [target]
 * @property {string} [layer]
 * @property {number} [weight]
 * @property {string} [label]
 * @property {Object} [payload] - JSON blob for producer-specific extras
 */

// ─── Working Context ───

/**
 * @typedef {Object} WeightVector
 * @property {number} calls
 * @property {number} calledBy
 * @property {number} memberOf
 * @property {number} shared
 * @property {number} sharedWrites
 * @property {number} sharedName
 * @property {number} [spatial]
 */

/**
 * @typedef {Object} LayerWeights
 * @property {WeightVector} affinity - how much each layer contributes to clustering
 * @property {WeightVector} physics - how strongly each layer attracts in layout
 * @property {WeightVector} opacity - visual opacity per layer
 */

/**
 * @typedef {Object} WorkingContext
 * @property {string} name - e.g. 'refactor-auth'
 * @property {LayerWeights} weights
 * @property {Set<string>} pinnedNodes - nodes kept in spatial focus
 * @property {Set<string>} pinnedClusters - clusters forced collapsed
 * @property {Set<string>} focalNodes - nodes the user is currently looking at
 * @property {Set<string>} lensEdgeLayers - which layers are currently relevant
 * @property {string} goal - human/AI description of current task
 */

// ─── Position State ───

/**
 * @typedef {Object} PositionState
 * @property {number} x
 * @property {number} y
 * @property {number} t0x - initial/rest x position
 * @property {number} t0y - initial/rest y position
 * @property {boolean} sticky - dampens gradient
 * @property {boolean} locked - zeroes gradient (immovable)
 */

// ─── Derivatives (computed, never stored as primary state) ───

/**
 * @typedef {Object} HyperEdge
 * @property {string} id
 * @property {string} layer
 * @property {string} commonMember - the node shared by all edges in this class
 * @property {Set<string>} edgeIds
 */

/**
 * @typedef {Map<string, number>} AffinityMap
 * Map from groupId to weight (sums to 1 for a given node).
 */

/**
 * @typedef {Object} Cluster
 * @property {string} id - the cluster-as-node id
 * @property {Set<string>} members - node ids belonging to this cluster
 * @property {string} sourceHyperEdge - the hyperedge this cluster was promoted from
 */

// ─── Rewrite Rules ───

/**
 * @typedef {Object} RewriteRule
 * @property {string} name - e.g. 'extract-function', 'rename', 'merge-clusters'
 * @property {string} description
 * @property {function} match - (graph) => MatchSite[]
 * @property {function} apply - (binding) => HistoryRow[]
 */

/**
 * @typedef {Object} MatchSite
 * @property {string} ruleId
 * @property {Object} binding - matched subgraph mapping
 * @property {string} description - human-readable summary
 */

export {
  // This module exports only types via JSDoc.
  // Named exports below are empty sentinels so the module is importable.
};
