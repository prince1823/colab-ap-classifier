/**
 * Utility to load and parse taxonomy YAML files
 */

export interface TaxonomyTreeNode {
  name: string
  path: string
  children: TaxonomyTreeNode[]
  count: number
  amount: number
}

interface TransactionRow {
  classification_path?: string
  taxonomy_path?: string
  spend_amount?: string | number
  [key: string]: unknown
}

export const buildTaxonomyTree = (taxonomyPaths: string[]): TaxonomyTreeNode => {
  const root: TaxonomyTreeNode = { name: 'Root', path: 'root', children: [], count: 0, amount: 0 }

  taxonomyPaths.forEach((pathStr: string) => {
    const parts = pathStr.split('|').map((p: string) => p.trim()).filter((p: string) => p)
    if (parts.length === 0) return

    let current: TaxonomyTreeNode = root
    let currentPath = 'root'

    parts.forEach((part: string) => {
      currentPath += `|${part}`

      let child = current.children.find((c: TaxonomyTreeNode) => c.name === part)
      if (!child) {
        child = {
          name: part,
          path: currentPath,
          children: [],
          count: 0,
          amount: 0
        }
        current.children.push(child)
      }

      current = child
    })
  })

  // Sort tree alphabetically by name at all levels
  const sortTreeAlphabetically = (node: TaxonomyTreeNode): void => {
    if (node.children && node.children.length > 0) {
      node.children.sort((a: TaxonomyTreeNode, b: TaxonomyTreeNode) => {
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      node.children.forEach(sortTreeAlphabetically)
    }
  }
  sortTreeAlphabetically(root)

  return root
}

export const populateTreeWithTransactions = (tree: TaxonomyTreeNode, transactions: TransactionRow[]): TaxonomyTreeNode => {
  // Reset counts
  const resetCounts = (node: TaxonomyTreeNode): void => {
    node.count = 0
    node.amount = 0
    node.children.forEach(resetCounts)
  }
  resetCounts(tree)

  // Count transactions for each path
  transactions.forEach((row: TransactionRow) => {
    const path = row.classification_path || row.taxonomy_path || ''
    const parts = path.split('|').filter((p: string) => p.trim())
    if (parts.length === 0) return

    const amount = parseFloat(String(row.spend_amount || 0)) || 0

    let current: TaxonomyTreeNode = tree
    current.count++
    current.amount += amount

    parts.forEach((part: string) => {
      const child = current.children.find((c: TaxonomyTreeNode) => c.name === part.trim())
      if (child) {
        child.count++
        child.amount += amount
        current = child
      } else {
        // Path doesn't exist in taxonomy - create it
        const newPath = current.path + `|${part.trim()}`
        const newChild: TaxonomyTreeNode = {
          name: part.trim(),
          path: newPath,
          children: [],
          count: 1,
          amount: amount
        }
        current.children.push(newChild)
        current = newChild
      }
    })
  })

  // Sort children alphabetically by name
  const sortTree = (node: TaxonomyTreeNode): void => {
    if (node.children) {
      node.children.sort((a: TaxonomyTreeNode, b: TaxonomyTreeNode) => {
        // Sort alphabetically by name (case-insensitive)
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      node.children.forEach(sortTree)
    }
  }
  sortTree(tree)

  return tree
}
