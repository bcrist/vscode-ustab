# Unit-Separator Tables

![Demo](images/demo.apng)

Allows for automatic alignment of different parts of adjacent lines within text documents.  This can be useful for aligning code structures that span multiple lines and authoring markdown tables.

The underlying concept is similar to [elastic tabstops](https://nick-gravgaard.com/elastic-tabstops/).  Those have a few glaring issues though:
* Since the idea never took off, most editors/viewers won't render the document in a way that looks good.  This is a big problem if you expect to interact with other people.
* Redefining the meaning of tab characters means if you do use an elastic tabstop plugin, you'll either incorrectly render lots of files that assume tabstops are fixed width, or not be able to enable it universally.

To avoid these pitfalls, we do a few things slightly differently:
* Instead of tabs, an ASCII control character (U+001F by default) is used to indicate that the text immediately following it should be visually aligned with the lines above/below.
* To ensure it looks good in all editors, alignment is achieved by inserting spaces or other padding characters, rather than custom rendering rules.

The padding character for each individual cell is whatever character exists just to the left of the cell separator character that ends the cell, unless that character doesn't exist or is in the ASCII alphanumeric ranges, in which case the padding defaults to spaces.

Since many programming languages treat all ASCII control characters as whitespace, you can often leave cell separators permanently in your code.

## Features

### Insert Cell Separators
Since VS Code doesn't make it particularly easy to insert arbitrary unicode codepoints, the `ustab.insertCellSeparator` command can be used to insert a cell separator character.  By default this is bound to `Ctrl` + `Shift` + `\`.
By default, the ASCII unit-separator character (U+001F) is used as the cell separator, but this can be changed to another control character, such as FS, GS, or RS, using the `ustab.cellSeparator` configuration setting.

### Format As You Go
By default, any edit which affects only a single line, if that line contain at least one cell separator, will cause that table to be reformatted automatically.
Automatic reformatting can be disabled or expanded to also include multi-line edits using the `ustab.formatOnChange` configuration setting.

### Manual Formatting
The `ustab.formatTable` command will reformat the current table.  By default this is bound to `Ctrl` + `K`, `T`.

The `ustab.formatAllTables` command will reformat all tables in the current file.

### Markdown Tables
Though not specifically designed for it, this extension works well for editing markdown tables.  To do so:
1. Execute the `ustab.unbakeTable` command while the cursor is within the markdown table to convert `|` characters to cell separators throughout the table.
2. Make your edits.
3. Execute the `ustab.bakeTable` command to convert the cell separators back to `|` characters.

> Note: If this is a use case you're intereseted in, you'll probably want to bind the above commands to keyboard shortcuts.

The commands `ustab.bakeAllTables` and `ustab.unbakeAllTables` operate the same way as the above commands, except they will transform all tables within the current file instead of just the current one.  Be careful with this in source code since `|` is an operator in most programming languages.

The `ustab.bakeString` configuration setting can be changed if you want to use a different character for the "baked" table rendering.

### Removing Tables
The `ustab.removeCellSeparators` command can be used to remove all cell separators from the current table, while keeping all the current cell padding.
`ustab.removeCellSeparatorsAllTables` does the same thing for all tables within the file.

### Improved Left/Right/Tab Navigation
Adjusted versions of some default cursor movement commands are provided.  These are not bound by default but you may choose to change your keybindings to use the following:
* `tab`: When in a table, select all text in the next cell (to the right).  When not in a table, execute the default `tab` command.
* `outdent`: When in a table, select all text in previous cell (to the left).  When not in a table, execute the default `outdent` command.
* `cursorLeft`: When the cursor is currently within the "padding" area of a cell, move it to the end of the text in the cell.  Otherwise identical to the default `cursorLeft` command.
* `cursorRight`: When the cursor is at the end of the text of a cell, move to just before the cell separator character.  Otherwise identical to the default `cursorRight` command.
* `cursorLeftSelect`, `cursorRightSelect`: Same as above, but adjusts the current selection instead of wiping out the selection origin point(s).

## Known Limitations & Issues
* Use of tab characters may cause table misalignments unless every line of a table uses tabs in the same places
* Use of unicode codepoints outside the BMP within a table may cause unexpected behavior
