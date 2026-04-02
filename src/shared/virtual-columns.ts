/**
 * Virtual column registry for the transactions table.
 *
 * Virtual columns are resolved via JOINs and have no physical presence on the
 * transactions table. They can be SELECTed and filtered on, but they must never
 * appear in column_priorities — extractFields() reads raw transaction rows where
 * these columns don't exist, so they would always be silently absent from dedup groups.
 */

interface VirtualColumnDef {
  /** SQL expression when this column appears in a SELECT (using standard JOIN aliases). */
  selectExpr: string;
  /** The JOIN clause required to resolve this column. */
  requiredJoin: 'supplier' | 'taxonomy' | 'rules' | 'supplier_parent';
}

export const VIRTUAL_COLUMN_REGISTRY: Record<string, VirtualColumnDef> = {
  supplier_name:       { selectExpr: 'ps.supplier_name',                          requiredJoin: 'supplier'        },
  is_tail_spend:       { selectExpr: 'ps.is_tail_spend',                          requiredJoin: 'supplier'        },
  is_researched:       { selectExpr: 'ps.is_researched',                          requiredJoin: 'supplier'        },
  confirmation_status: { selectExpr: 'ps.confirmation_status',                     requiredJoin: 'supplier'        },
  parent_name:         { selectExpr: 'sp.name',                                   requiredJoin: 'supplier_parent' },
  classification_l1:   { selectExpr: 'tax.l1',                                    requiredJoin: 'taxonomy'        },
  classification_l2:   { selectExpr: 'tax.l2',                                    requiredJoin: 'taxonomy'        },
  classification_l3:   { selectExpr: 'tax.l3',                                    requiredJoin: 'taxonomy'        },
  classification_path: { selectExpr: "CONCAT_WS(' > ', tax.l1, tax.l2, tax.l3)", requiredJoin: 'taxonomy'        },
  applied_rule_name:   { selectExpr: 'ar.name',                                   requiredJoin: 'rules'           },
};

/**
 * Set of all virtual column names — resolved via JOINs, not physically stored on transactions.
 *
 * Use this to:
 * - Filter column_priorities before saving (virtual columns must never be saved to priorities)
 * - Strip virtual columns from priorities at read time in the classification runner (safety net)
 * - Exclude virtual column names from physical-column SQL queries (e.g. rule generation)
 */
export const VIRTUAL_COLUMN_NAMES = new Set(Object.keys(VIRTUAL_COLUMN_REGISTRY));
