/** Numeric AVL map for bounded ordered range removal and interval coverage. */
type Node<T> = { key: number; value: T; height: number; left?: Node<T>; right?: Node<T> }
export function createNumericTree<T>() {
  let root: Node<T> | undefined
  const height = (node?: Node<T>) => node?.height ?? 0
  const fix = (node: Node<T>) => { node.height = 1 + Math.max(height(node.left), height(node.right)); return node }
  const right = (node: Node<T>) => { const top = node.left!; node.left = top.right; top.right = fix(node); return fix(top) }
  const left = (node: Node<T>) => { const top = node.right!; node.right = top.left; top.left = fix(node); return fix(top) }
  const balance = (node: Node<T>) => {
    fix(node); const delta = height(node.left) - height(node.right)
    if (delta > 1) { if (height(node.left!.left) < height(node.left!.right)) node.left = left(node.left!); return right(node) }
    if (delta < -1) { if (height(node.right!.right) < height(node.right!.left)) node.right = right(node.right!); return left(node) }
    return node
  }
  const put = (node: Node<T> | undefined, key: number, value: T): Node<T> => {
    if (!node) return { key, value, height: 1 }
    if (key < node.key) node.left = put(node.left, key, value)
    else if (key > node.key) node.right = put(node.right, key, value)
    else node.value = value
    return balance(node)
  }
  const remove = (node: Node<T> | undefined, key: number): Node<T> | undefined => {
    if (!node) return
    if (key < node.key) node.left = remove(node.left, key)
    else if (key > node.key) node.right = remove(node.right, key)
    else {
      if (!node.left) return node.right
      if (!node.right) return node.left
      let successor = node.right; while (successor.left) successor = successor.left
      node.key = successor.key; node.value = successor.value; node.right = remove(node.right, successor.key)
    }
    return balance(node)
  }
  return {
    set(key: number, value: T) { root = put(root, key, value) },
    delete(key: number) { root = remove(root, key) },
    get(key: number) { let node = root; while (node) { if (key === node.key) return node.value; node = key < node.key ? node.left : node.right } return undefined },
    lowerBound(key: number) { let node = root, found: Node<T> | undefined; while (node) { if (node.key >= key) { found = node; node = node.left } else node = node.right } return found && { key: found.key, value: found.value } },
    floor(key: number) { let node = root, found: Node<T> | undefined; while (node) { if (node.key <= key) { found = node; node = node.right } else node = node.left } return found && { key: found.key, value: found.value } },
  }
}
