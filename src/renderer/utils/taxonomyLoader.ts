/**
 * Utility to load and parse taxonomy YAML files
 */

export const buildTaxonomyTree = (taxonomyPaths) => {
  const root = { name: 'Root', path: 'root', children: [], count: 0, amount: 0 }
  
  taxonomyPaths.forEach(pathStr => {
    const parts = pathStr.split('|').map(p => p.trim()).filter(p => p)
    if (parts.length === 0) return
    
    let current = root
    let currentPath = 'root'
    
    parts.forEach((part) => {
      currentPath += `|${part}`
      
      let child = current.children.find(c => c.name === part)
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
  const sortTreeAlphabetically = (node) => {
    if (node.children && node.children.length > 0) {
      node.children.sort((a, b) => {
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      node.children.forEach(sortTreeAlphabetically)
    }
  }
  sortTreeAlphabetically(root)
  
  return root
}

export const populateTreeWithTransactions = (tree, transactions) => {
  // Reset counts
  const resetCounts = (node) => {
    node.count = 0
    node.amount = 0
    node.children.forEach(resetCounts)
  }
  resetCounts(tree)
  
  // Count transactions for each path
  transactions.forEach(row => {
    const path = row.classification_path || row.taxonomy_path || ''
    const parts = path.split('|').filter(p => p.trim())
    if (parts.length === 0) return
    
    const amount = parseFloat(row.spend_amount || 0) || 0
    
    let current = tree
    current.count++
    current.amount += amount
    
    parts.forEach((part) => {
      const child = current.children.find(c => c.name === part.trim())
      if (child) {
        child.count++
        child.amount += amount
        current = child
      } else {
        // Path doesn't exist in taxonomy - create it
        const newPath = current.path + `|${part.trim()}`
        const newChild = {
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
  const sortTree = (node) => {
    if (node.children) {
      node.children.sort((a, b) => {
        // Sort alphabetically by name (case-insensitive)
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      node.children.forEach(sortTree)
    }
  }
  sortTree(tree)
  
  return tree
}
