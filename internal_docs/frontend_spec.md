# Frontend Spec Doc

> **References:** Product decisions and feature definitions are in [features.md](./features.md). This document covers UI layouts, interactions, constraints, and edge cases only.

## Objectives

- Create a tool, not a website.
- Give the user freedom to do whatever they want, but in ways that require as little manual work on the user's part as possible.

---

## Global UI Behavior

### Project Selector (persistent)

- Always visible in header
- Shows current project name
- Dropdown with:
  - List of existing projects
  - "New Project" option
- On app start: if no project selected, prompt user to select or create a project before showing workflow

### Workflow Tabs (within a project)

**Upload → Canonicalization → Data Review → Classification → Review → Output**

Sections are disabled until prerequisites are met (tooltip explains why on hover)

### Workflow State Rules

- Upload, Canonicalization, and Data Review operate on one dataset at a time
- If a classification job is running:
  - Upload, Canonicalization, and Data Review show the current dataset's settings in read-only mode with a banner: "Classification in progress. Settings cannot be changed."
  - Classification tab shows progress with cancel option
  - Users cannot start a new upload until job completes or is cancelled
- Review and Output include a dataset selector to access any previously classified dataset
- **Project Views:** Always accessible regardless of workflow state. These views show data scoped to the current project. Sidebar section label: "PROJECT".

---

## Thread 1: Project Setup

### 1.1 Create or Select Project

> See [features.md §1](./features.md) for project management behavior.

**Description:** The user creates a new project or selects an existing one to work on.

**What the user sees:**
- Project selector dropdown showing existing projects
- "New Project" button
- For new projects: form with project name field
- Summary of selected project (company context, datasets, last modified)

**Interactions:**
- Select existing project from dropdown → loads project settings and datasets
- Create new project → enters project name → proceeds to company context setup

**Constraints:**
- Project name must be unique

### 1.2 Project Settings

**Description:** Configure project-level settings.

**What the user sees:**
- Company context form: industry, sector, description, business focus, procurement nuances
- Taxonomy selector (dropdown of available taxonomies from ColabIP, with auto-suggestion based on industry)
- Preview of selected taxonomy (structure + descriptions)
- Info note near taxonomy selector: L1 is constrained to Direct / Indirect / Exempt (see [features.md §3](./features.md) for definitions)
- Override Rules section (rules applied with highest priority)
- Tail Spend Threshold setting with input field (default: $10,000)

**Interactions:**
- Fill out or edit company context fields → save
- Select taxonomy from dropdown → view preview → confirm
- Edit tail spend threshold → save
- Add/edit/remove override rules

**Constraints:**
- Company context and taxonomy are required before proceeding to Upload
- Tail spend threshold set here is used both for classification scope and for the filter in Review

---

## Thread 2: Prepare and Review Data

### 2.1 Upload

> See [features.md §2](./features.md) for data import behavior.

**Description:** Upload a new CSV dataset within the current project.

**What the user sees:**
- Upload area for CSV file
- Option to add to existing dataset or create new
- For "Add to Existing": dropdown of datasets in this project

**Interactions:**
- Drag-and-drop or click to upload CSV
- Choose "New Dataset" or "Add to Existing"

**Constraints:**
- If project has an existing canonicalization mapping, uploaded columns must match
- On upload: rows are inserted into Transactions with classification fields null

### 2.2 Column Canonicalization

**Description:** View + edit canonicalized columns, ensuring that the correct data is used for deciding classifications. Also choose columns for invoice-level grouping.

**What the user sees:**
- Original column name → mapped to canonicalized column name
- Canonicalized names are selected from a predefined list
- Current columns chosen for invoice-level grouping

**Interactions:**
- Expanded view to see sample values for the column
- Add a new canonicalized column (choose original column name and map to possible canonicalized column names)
- Delete canonicalized column
- Edit original column name for an existing canonicalized column
- Add/remove from invoice-level grouping columns

### 2.3 Review Shape of Data

**Description:** Review the shape of the data before classification, including supplier analysis and parenting.

#### Data Quality Checks

**What the user sees:**
- Checkmarks for required columns (supplier name, line description, spend amount) when populated
- Warning messages if >10% of rows have empty/unreadable values in required columns

**Interactions:**
- Proceed (enabled even with warnings) / Return to upload page
- If warnings exist, "Proceed" shows confirmation: "X rows have missing data and may not classify correctly. Continue?"

#### Data Summary

**What the user sees:**
- Total row count
- Total spend amount
- Number of unique suppliers
- Spend distribution chart (by supplier, by category if available)
- Top suppliers by spend (table)

#### Suppliers Review

**What the user sees:**
- Supplier table with supplier parent, etc.

**Interactions:**
- In-line edit to change supplier parent

---

## Thread 3: Classification

> See [features.md §5](./features.md) for classification pipeline behavior. See [features.md §4](./features.md) for automatic supplier research.

**Description:** Run the classification for the current dataset. Supplier research runs automatically as the first step — the progress display reflects both research and classification phases.

**What the user sees:**
- Progress bar showing invoices processed (e.g., "1,204 / 15,000 invoices classified")
- Estimated time remaining

**Interactions:**
- Start classification
- Cancel current run (with confirmation modal)
- Pause and resume (if feasible)
- Retry (if previous run failed)

**Constraints:**
- Only one classification job can run at a time
- Once classification starts, the taxonomy selection is locked for that dataset. To use a different taxonomy, upload the data as a new dataset/re-run.

**Edge cases:**
- User quits browser before starting classification → Dataset remains in "Uploaded" status. On return, user continues from where they left off in the workflow.
- User closes browser mid-run → Job continues server-side. On return, user sees progress banner.
- Classification fails partway through → Show error message with retry option.
- Dataset has already been classified → Re-run is triggered from Review section (see 4.1).

---

## Thread 4: Classification Review + System Improvement

> See [features.md §7](./features.md) for review behavior. See [features.md §6](./features.md) for review score definition.

### 4.1 Explore + Correct Classifications

**Description:** Tool that allows the user to find and reclassify incorrectly classified rows.

#### Layout

- Dataset selector dropdown at top (shows all classified datasets)
- Data table (configurable columns, starting with supplier, line description, level classification, spend amount)
- Filter panel
- Taxonomy tree panel for reclassification
- Expandable metrics section
- Help button to guide the user on how to use the filters
- Chat feedback panel (collapsible)

#### Investigation

**What the user sees:**
- Tables with columns + spend amount. Default columns: supplier, line description, level classification. Dropdown on the side to alter which columns are shown.
- Toggle to show only flagged for review rows (rows with high review scores)
- Toggle to filter out tail spend suppliers
  - When enabled, shows: "Threshold: $[value]" (value from Project Settings) — read-only display, edit in Project Settings
  - Click edit → inline input to change value
- Expandable metrics section:
  - Total rows / total spend
  - Flagged rows: count pending review, count reviewed
- Review score range filter (0-100 slider)

**Interactions:**
- Choose which columns to see via dropdown
- Drag a row to the filter panel → creates a filter for that row's value (e.g., drag a row with supplier "Acme" → filters to all Acme rows)
- Combine filters with AND / OR logic
- Filter for flagged for review rows via toggle
- Filter by review score range
- Filter out tail spend suppliers via toggle

#### Reclassification

**What the user sees:**
- Taxonomy tree panel showing all available classifications

**Interactions:**
- Drag a set of rows to a node in the taxonomy tree → see confirmation message → reclassification applied
- Undo/redo reclassification actions: `Ctrl/Cmd + Z` and `Ctrl/Cmd + Shift + Z`. History is cleared on page refresh.

**Constraints:**
- Changes are saved immediately (no explicit save button)

#### System Feedback Generation

> See [features.md §8](./features.md) for feedback types and behavior.

**What the user sees:**
- Toggle between automatic feedback creation and just a basic correction.
  - **ON:** Reclassifications trigger AI to suggest rules or description changes (visible in 4.2)
  - **OFF:** Reclassifications apply to selected rows only, no suggestions generated
- Notification when a new system feedback suggestion is created

**Interactions:**
- Toggle system feedback generation on/off
- If rows being reclassified were already reclassified prior and two different changes are made to the same row: pop-up notification allows user to override existing feedback or cancel current action

**Edge Cases:**
- User reclassifies rows matched by an override rule → show warning: "These rows are controlled by override rules. Are you sure you want to continue with this action?"
- No flagged rows exist → toggle is disabled with tooltip

### 4.2 System Feedback

**Description:** Dashboard where the user reviews, edits, and applies AI-generated suggestions for improving taxonomy descriptions, company context, or rules.

**What the user sees:**
- List of pending feedback suggestions, grouped by type:
  - Taxonomy description change
  - Company context change
  - New rule suggestion
  - Supplier rule suggestion
- For each suggestion: affected rows, proposed change, approve/reject buttons
- Editable text field for description/context changes before approval

**Interactions:**
- Approve feedback → applies change
- Reject feedback → discards suggestion
- Edit proposed text before approving

**Edge Cases:**
- No pending feedback → show empty state: "No suggestions yet. Feedback is generated when you reclassify rows."

---

## Thread 5: Project Views

> See [features.md §9](./features.md) for data store features.

### 5.1 Taxonomy

> See [features.md §3](./features.md) for taxonomy structure and L1 constraints.

**Description:** Browse and edit the taxonomy for this project's industry. Edits here apply to this project only.

**What the user sees:**
- Header: "Taxonomy: [Industry Name]" (e.g., "Taxonomy: Healthcare") with taxonomy version
- Table view of taxonomy nodes (L1→L2→L3 hierarchy)

**Interactions:**
- Filter at any level
- **Add node:** Click "Add Node" → modal with dropdowns for L1/L2/L3 + description field
- **Rename node:** Double-click cell → edit inline → save
- **Edit description:** Double-click description cell → edit inline → save
- **Delete node:** Row action menu (three dots) → "Delete" → reassignment flow:
  1. User clicks delete
  2. Modal shows: "X rows are classified to this node."
  3. User selects reassignment:
     - Choose another node (dropdown)
     - Mark as unclassified (rows flagged for review)
  4. Confirm → node deleted, rows reassigned

**Note:** Taxonomy change history is tracked via GitHub (ColabIP sync), not in-app.

**Constraints:**
- Cannot delete a node without reassigning affected rows
- All changes are logged to history
- Taxonomy descriptions are editable inline. Changes are logged to system feedback history.

**Edge Cases:**
- Delete node referenced by a rule → Warning: "X rules reference this node. Deleting will deactivate these rules."

### 5.2 Company Context

**Description:** View and edit the company context for this project.

**What the user sees:**
- Company context form showing: industry, sector, description, business focus, procurement nuances

**Interactions:**
- Edit any field inline → save

### 5.3 Project Suppliers

> See [features.md §4](./features.md) for supplier research and type classification.

**Description:** Dashboard listing all suppliers found in this project's transaction data.

**What the user sees:**
- Table with: supplier name, supplier type (company / individual / government), supplier parent, historical classifications for this supplier, Category A status and classification

**Interactions:**
- Edit supplier type inline (dropdown: company / individual / government)
- Edit supplier parent inline
- Mark/unmark supplier as Category A with taxonomy node selector for the predetermined classification

### 5.4 Override Rules

> See [features.md §5](./features.md) for override rule behavior, sources, and types.

**Description:** All override rules that apply to this project's classifications, across all sources.

**What the user sees:**
- Table with columns: Rule Name, Priority Score, Source, Condition (e.g., "Supplier = Acme AND Description contains 'consulting'"), Target Classification, Created By, Created On
- Affected row count for each rule
- Filter/group by source (project, taxonomy, supplier)

**Interactions:**
- Create new rule (modal with condition builder + classification selector + source selector)
- Edit rule (same modal, pre-filled) — all rules editable regardless of source
- Delete rule (with confirmation)
- View affected rows

**Edge Cases:**
- New rule conflicts with existing rule → show warning with option to proceed or cancel

### 5.5 Project History

**Description:** Dashboard for viewing all changes made to this project's transaction classifications and reverting if needed.

**What the user sees:**
- Timeline of all changes to this project's Transactions table
- Each entry shows: timestamp, change type, rows affected, summary of change, source (manual reclassification / rule applied / system feedback)
- Filter by date range or source

**Interactions:**
- Click on any change to see affected rows
- "Revert" button on each change → confirmation modal → undoes that change
- Export change log as CSV

**Constraints:**
- Reverting a change creates a new entry in the history (changes are never deleted)

---

## Thread 6: Download

> See [features.md §10](./features.md) for export and sync behavior.

**Description:** Export the final classified dataset.

**What the user sees:**
- Dataset selector dropdown (shows all classified datasets)
- Download button (disabled if no dataset is selected)
- Label indicating the file includes latest corrections
- "Sync to ColabIP" button to push changes to the shared repository

**Interactions:**
- Click to download CSV
- Click "Sync to ColabIP" → pushes taxonomy, supplier universe, and override rules to GitHub repo

**Constraints:**
- File reflects all reclassifications and applied override rules at time of download

**Edge Cases:**
- Classification not yet complete → Button disabled, tooltip: "Complete classification to download"
- User made corrections after last download → No warning needed; download always gets latest version

---

## Technical Requirements

- Form inputs and in-progress work are cached locally. Page reload does not lose unsaved changes.

---

## Glossary

> Product-level definitions (override rules, review score, etc.) are in [features.md](./features.md). This glossary covers UI-specific terms only.

| Term | Definition |
|------|------------|
| **Manual Edit** | A direct change made by the user in the Project Views UI, as opposed to approving an AI suggestion. |
| **Flagged for Review** | A row with a review score above the threshold, indicating it should be checked by a human. See [features.md §6](./features.md). |
| **ColabIP** | Shared GitHub repository containing master taxonomy, supplier universe, and override rules. |
