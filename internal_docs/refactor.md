# refactoring codebase.
## starting with the boxes.
__TODO's in x box will only be handled during the refactoring of the box referenced in the TODO.__

### projects
#### spec
- lifecycle: create, open, close project file
- crud on any key-value pair in project_settings
	- project name
	- company context json
	- tail spend threshold
- file dialogs (save/open .c91)
- ensure indexes on open

#### breaking changes
- remove column_mappings and taxonomy name

TODO:
- ingest_data
    - add column mappings
- taxonomy
    - add hastaxonomy function that checks if taxonomy table is populated
        - IPC handler for the same

#### tests
**createProject**
- creates .c91 file and initialises schema
- creates parent directory if missing
- throws on empty name
- throws if file already exists

**openProject**
- opens existing .c91 and returns name
- reads settings after opening
- throws if file missing
- throws on empty path
- derives name from filename when no project_name setting

**closeProject**
- closes DB and clears state
- operations throw after close

**isProjectOpen**
- false when nothing opened
- true when project is open

**Settings KV CRUD**
- creates new key via setSetting
- overwrites existing key on re-set
- returns undefined for non-existent key
- deletes key, returns undefined after
- no-throw on deleting non-existent key
- getAllSettings returns seeded defaults
- handles JSON object values

**File dialogs**
- selectSavePath returns chosen path
- selectSavePath returns null on cancel
- selectOpenPath returns chosen path
- selectOpenPath returns null on cancel



### ingest_data
#### spec
- select file, parse csv (today: csv only)
	- file dialog → columns + sample rows + row count

- column mappings
	- add new column
	- change mapped column
	- delete column
	- set classification priority per column (1 = highest, no number = don't send)
	- save mappings to column_mappings key in uploads table

- import csv
	- create transactions table with mapped columns + set columns (classification_status classification_reasoning, taxonomy_node_id, row_index, id)
	- unmapped csv columns are not added to transactions
	- batch insert rows

#### breaking changes
- new uploads table (id, file_name, column_mappings json, row_count, created_at)
- column_mappings moves from project table → uploads table
- split parsePreview into parseCSV + suggestMappings (separate IPC calls)
- rename upload:* → ingest:*

TODO:
- classification
    - read classificationPriority from uploads.column_mappings to filter which columns are sent to the LLM

---

## TODO for kavya:
- get clarity:
    - every single place in the codebase where the frontend reaches into the backend/tables directly as opposed to via IPC handlers. this should not happen. frontend-backend contract needs to solid and followed.