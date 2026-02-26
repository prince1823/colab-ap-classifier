# Project Flow

1. New project
2. Fill out project details:
   1. Company context
      1. Blank textboxes, save in project table
   2. Choose taxonomy (from available colabip taxonomies)
      1. Create taxonomy table
   3. Settings (tail spend threshold)
      1. Save in project table
3. Upload CSV
   1. Column mapping llm outputs column map json
      1. Because if tomorrow some structural change happens like invoice grouping is inferred from two not one column, etc.
      2. Have supplier address in the list too
   2. Column mapping human confirmed + choose invoice grouped columns
      1. Save in project table
   3. Transactions table created with mapped columns + default columns (llm reasoning, classification_status, etc). Other columns dropped.
4. Review shape of data
   1. __This section allows a quick review of data to see everything is okay.__ Typical checks include
      1. Time period of data - check if it has transactions for the correct range
         1. Show # of transactions over the time period to ensure data is uniformly distributed/distributed as expected
      2. Show general shape of spend
         1. show top suppliers ( it doesn't even matter if its normalised)
5. Load + review override rules
   1. Load rules. Group them by RULE TYPE
      1. Rule type = which column (supplier rule, GL rule, Mixed Rule, etc.)
   2. Rule table:
      1. Rule name
      2. Priority number (unique, positive)
      3. Filter condition
      4. Target Taxonomy
   3. In a rule prioritization view, move rows up/down to indicate priority. Accordingly, change priority score.
   4. Add/edit/delete any rules in the project.
      1. Info needed for a rule: priority score (automatically set, can be changed by user), conditions (based on any column name, AND OR filtering), target taxonomy node.
6. Supplier Research
   1. Read list of suppliers, related columns (e.g. address) and send to supplier service
   2. Supplier service sends back per supplier
      1. UID of supplier
      2. Normalised Supplier List
         1. Normalised name of supplier
         2. Parent (if exists)
         3. Supplier context
            1. Supplier info
      3. Any Supplier Universe Rules (category A rules)
   3. As suppliers are sent back, user reviews/edits on a supplier review page.
      1. Page shows supplier table (supplier_universe.db) — default filter for project suppliers
      2. Manually edit any fields in supplier database (eg. parent)
7. Classification
   1. Send all transactions of each confirmed supplier to override rules engine
      1. Compare incoming transaction info to conditions in the rules table to match to the highest priority matching rule. Return node.
         1. If rule applies, mark classification_status as "classified by rule"
         2. If not classification_status remains "unclassified"
   2. Send remaining rows for that supplier batch to AI classification engine
      1. Construct LLM payload with supplier info, transaction info, taxonomy, company context. Return node.
         1. NOTE: use prompt caching and context engineering for efficiency
      2. Based on result, update taxonomy_node, classification_status="classified by ai"
8. Review Returned Data
   1. For every batch sent to classification, show results in a review pane, and allow them to edit.
   2. Allow for viewing multiple batches together.
   3. Let them select one or more rows at a time and either
      1. Mark correct. Therefore, set classification_status="human_reviewed"
      2. Reclassify based on filters. Therefore, call update_Transaction()
         1. TODO: The UI specific thing has to be detailed here, since this is complex.
   4. Update_Transaction will
      1. Update the transaction table
      2. Every change made is updated in change_log
9. Manually add/edit/delete taxonomy nodes.
   1. In "pivot table mode" - no reclassification, only viewing
   2. In "review" mode
10. View/revert changes
    1. If change is reverted, append new change_log row.
11. Download dataset as csv, with all the canonicalized columns and taxonomy classifications.
