/**
 * Barnes-Hut 2D spatial index; octree-ready interface.
 * @module layout/quadtree
 */

export function createQuadtree() {}

export function insert(tree, point) {}

export function remove(tree, point) {}

export function rebuild(tree, points) {}

export function approximateRepulsion(tree, node, theta) {}

export function nearest(tree, point, k) {}
