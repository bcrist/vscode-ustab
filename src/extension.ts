import * as vscode from 'vscode';

enum FormatOnChange {
	disabled,
    singleLineOnly,
    always,
}

let cellSeparator = '\u001f';
let formatOnChange = FormatOnChange.singleLineOnly;
let bakeString = '';

function loadConfiguration() {
	const config = vscode.workspace.getConfiguration('ustab');
	cellSeparator = config.get('cellSeparator', cellSeparator);
	formatOnChange = FormatOnChange[config.get<string>('formatOnChange', formatOnChange.toString()) as keyof typeof FormatOnChange];
	bakeString = config.get('bakeString', bakeString);
	console.log("Updated settings, cellSeparator = " + cellSeparator + "   formatOnChange = " + formatOnChange + "  bakeString = " + bakeString);
}

function countSeparators(doc: vscode.TextDocument, line: number, separatorString: string): number {
	if (line < 0 || line >= doc.lineCount) return 0;
	const text = doc.lineAt(line).text;
	let count = 0;
	let startingIndex = 0;
	while (true) {
		const separatorIndex = text.indexOf(separatorString, startingIndex);
		if (separatorIndex < 0) break;
		count += 1;
		startingIndex = separatorIndex + separatorString.length;
	}
	return count;
}

function addTableLinesAbove(doc: vscode.TextDocument, line: number, separatorString: string, minCount: number, tableLines: Set<number>) {
	if (tableLines.has(line)) return;
	if (countSeparators(doc, line, separatorString) < minCount) return;
	tableLines.add(line);
	addTableLinesAbove(doc, line - 1, separatorString, minCount, tableLines);
}

function addTableLinesBelow(doc: vscode.TextDocument, line: number, separatorString: string, minCount: number, tableLines: Set<number>) {
	if (tableLines.has(line)) return;
	if (countSeparators(doc, line, separatorString) < minCount) return;
	tableLines.add(line);
	addTableLinesBelow(doc, line + 1, separatorString, minCount, tableLines);
}

function addTableLine(doc: vscode.TextDocument, line: number, separatorString: string, minCount: number, tableLines: Set<number>): boolean {
	if (tableLines.has(line)) return false;
	if (countSeparators(doc, line, separatorString) < minCount) return false;
	tableLines.add(line);
	return true;
}

function getTableLines(textEditor: vscode.TextEditor, separatorString: string): Set<number> {
	const tableLines = new Set<number>();
	for (const selection of textEditor.selections) {
		for (let line = selection.start.line; line <= selection.end.line; ++line) {
			addTableLine(textEditor.document, line, separatorString, 1, tableLines);
		}
	}
	return tableLines;
}

function isValidPaddingCharCode(charCode: number): boolean {
	if (charCode >= 'a'.charCodeAt(0) && charCode <= 'z'.charCodeAt(0)) return false;
	if (charCode >= 'A'.charCodeAt(0) && charCode <= 'Z'.charCodeAt(0)) return false;
	if (charCode >= '0'.charCodeAt(0) && charCode <= '9'.charCodeAt(0)) return false;
	if (charCode >= 0xD800 && charCode < 0xE000) return false;
	return true;
}

class Cell {
	readonly line: number;
	readonly startOffset: number;
	readonly textEndOffset: number;
	readonly endOffset: number;
	readonly columnIndex: number | undefined;
	readonly paddingChar: string;
	readonly isFinalCell: boolean;

	constructor(columnIndex: number | undefined, lineText: string, line: number, startOffset: number, endOffset: number, isFinalCell: boolean) {
		let paddingChar = ' ';
		let textEndOffset = endOffset;
		if (endOffset > startOffset) {
			let paddingCharCode = lineText.charCodeAt(endOffset - 1);
			if (isValidPaddingCharCode(paddingCharCode)) {
				paddingChar = String.fromCharCode(paddingCharCode);
				textEndOffset -= 1;
				while (startOffset < textEndOffset && lineText.charCodeAt(textEndOffset - 1) === paddingCharCode) {
					textEndOffset -= 1;
				}
			}
		}

		this.line = line;
		this.startOffset = startOffset;
		this.textEndOffset = textEndOffset;
		this.endOffset = endOffset;
		this.columnIndex = columnIndex;
		this.paddingChar = paddingChar;
		this.isFinalCell = isFinalCell;
	}

	textRange(): vscode.Selection {
		return new vscode.Selection(this.line, this.startOffset, this.line, this.textEndOffset);
	}
	paddingRange(): vscode.Selection {
		return new vscode.Selection(this.line, this.textEndOffset, this.line, this.endOffset);
	}
	range(): vscode.Selection {
		return new vscode.Selection(this.line, this.startOffset, this.line, this.endOffset);
	}

	textWidth(): number {
		return this.textEndOffset - this.startOffset;
	}
	paddingWidth(): number {
		return this.endOffset - this.textEndOffset;
	}
	width(): number {
		return this.endOffset - this.startOffset;
	}

	widthIgnoringIndent(): number {
		return this.endOffset - (this.columnIndex === 0 ? 0 : this.startOffset);
	}
	textWidthIgnoringIndent(): number {
		return this.textEndOffset - (this.columnIndex === 0 ? 0 : this.startOffset);
	}
}

function* cells(doc: vscode.TextDocument, line: number, skipFinalCell?: boolean): Generator<Cell, void, unknown> {
	const textLine = doc.lineAt(line);
    const text = textLine.text;
	let startingOffset = 0;
	let isFinalCell = false;
	for (let column = 0; startingOffset <= text.length; ++column) {
		let cellEndOffset = text.indexOf(cellSeparator, startingOffset);
		if (cellEndOffset < 0) {
			if (skipFinalCell) break;
			cellEndOffset = text.length;
			isFinalCell = true;
		}
		yield new Cell(column, text, line, startingOffset, cellEndOffset, isFinalCell);
		startingOffset = cellEndOffset + cellSeparator.length;
	}
}

function currentCell(doc: vscode.TextDocument, pos: vscode.Position): Cell {
	const textLine = doc.lineAt(pos.line);
	const text = textLine.text;
	let startOffset = text.lastIndexOf(cellSeparator, pos.character - 1);
	if (startOffset < 0) {
		startOffset = 0;
	} else {
		startOffset += cellSeparator.length;
	}

	let isFinalCell = false;
	let endOffset = text.indexOf(cellSeparator, startOffset);
	if (endOffset < 0) {
		endOffset = text.length;
		isFinalCell = true;
	}

	return new Cell(undefined, text, pos.line, startOffset, endOffset, isFinalCell);
}

function formatTables(doc: vscode.TextDocument, lines: Set<number>, dontDeleteRanges: readonly vscode.Range[]) {
	if (lines.size === 0) return;

	const edit = new vscode.WorkspaceEdit();

	for (let column = 0; true; ++column) {
		const tableLines = new Set<number>();
		for (const line of lines) {
			if (addTableLine(doc, line, cellSeparator, column + 1, tableLines)) {
				addTableLinesAbove(doc, line - 1, cellSeparator, column + 1, tableLines);
				addTableLinesBelow(doc, line + 1, cellSeparator, column + 1, tableLines);
			}
		}

		if (tableLines.size === 0) break;
	
		let firstLineOfTable: number | null = null;
		let lastLineOfTable: number = 0;

		for (const line of Array.from(tableLines).sort((a, b) => a === b ? 0 : a < b ? -1 : 1)) {
			if (firstLineOfTable === null) {
				firstLineOfTable = line;
				lastLineOfTable = line;
				continue;
			}

			if (lastLineOfTable + 1 === line) {
				lastLineOfTable = line;
				continue;
			}

			alignSeparators(doc, firstLineOfTable, lastLineOfTable, dontDeleteRanges, column, edit);

			firstLineOfTable = line;
			lastLineOfTable = line;
		}

		if (firstLineOfTable !== null) {
			alignSeparators(doc, firstLineOfTable, lastLineOfTable, dontDeleteRanges, column, edit);
		}
	}

	if (edit.size > 0) vscode.workspace.applyEdit(edit);
}

function alignSeparators(doc: vscode.TextDocument, firstLine: number, lastLine: number, dontDeleteRanges: readonly vscode.Range[], columnToAlign: number, edit: vscode.WorkspaceEdit) {
	let targetCellWidth = 0;

	for (let line = firstLine; line <= lastLine; ++line) {
		for (const cell of cells(doc, line, true)) {
			if (cell.columnIndex !== columnToAlign) continue;
			if (cell.widthIgnoringIndent() <= targetCellWidth) continue;

			let desiredWidth = cell.textWidthIgnoringIndent();
			if (cell.textWidth() > 0) desiredWidth += 1;
			for (const range of dontDeleteRanges) {
				if (range.intersection(cell.paddingRange()) !== undefined) {
					desiredWidth = cell.widthIgnoringIndent();
					break;
				}
			}

			if (desiredWidth > targetCellWidth) targetCellWidth = desiredWidth;

			break;
		}
	}

	for (let line = firstLine; line <= lastLine; ++line) {
		for (const cell of cells(doc, line, true)) {
			if (cell.columnIndex !== columnToAlign) continue;
			const width = cell.widthIgnoringIndent();
			if (width < targetCellWidth) {
				const newText = cell.paddingChar.repeat(targetCellWidth - width);
				edit.insert(doc.uri, new vscode.Position(line, cell.endOffset), newText);
			} else if (width > targetCellWidth) {
				edit.delete(doc.uri, new vscode.Range(line, cell.endOffset - width + targetCellWidth, line, cell.endOffset));
			}
			break;
		}
	}
}

function replaceAll(doc: vscode.TextDocument, searchString: string, replacementString: string, lines: Set<number> | undefined) {
	if (lines !== undefined && lines.size === 0) return;

	const edit = new vscode.WorkspaceEdit();

	if (lines === undefined) {
		for (var line = 0; line < doc.lineCount; ++line) {
			replaceInLine(doc, line, searchString, replacementString, edit);
		}
	} else {
		const tableLines = new Set<number>(lines);
		for (const line of lines) {
			addTableLinesAbove(doc, line - 1, searchString, 1, tableLines);
			addTableLinesBelow(doc, line + 1, searchString, 1, tableLines);
		}
	
		for (const line of tableLines) {
			replaceInLine(doc, line, searchString, replacementString, edit);
		}
	}

	if (edit.size > 0) vscode.workspace.applyEdit(edit);
}

function replaceInLine(doc: vscode.TextDocument, line: number, searchString: string, replacementString: string, edit: vscode.WorkspaceEdit) {
	const text = doc.lineAt(line).text;
	let startingIndex = 0;
	while (true) {
		const usIndex = text.indexOf(searchString, startingIndex);
		if (usIndex < 0) break;
		edit.replace(doc.uri, new vscode.Range(line, usIndex, line, usIndex + searchString.length), replacementString);
		startingIndex = usIndex + searchString.length;
	}
}

export function activate(context: vscode.ExtensionContext) {
	loadConfiguration();

	vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
		loadConfiguration();
	}, undefined, context.subscriptions);

	vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
		if (formatOnChange === FormatOnChange.disabled) return;

		const doc = e.document;

		const tableLines = new Set<number>();

		for (const change of e.contentChanges) {
			for (let line = change.range.start.line; line <= change.range.end.line; ++line) {
				addTableLine(doc, line, cellSeparator, 1, tableLines);
			}
			let line = change.range.start.line;
			let startingIndex = 0;
			while (true) {
				const newlineIndex = change.text.indexOf('\n', startingIndex);
				if (newlineIndex < 0) break;
				line += 1;
				addTableLine(doc, line, cellSeparator, 1, tableLines);
				startingIndex = newlineIndex + 1;
			}
		}

		if (formatOnChange === FormatOnChange.singleLineOnly && tableLines.size > 1) return;

		let dontDeleteRanges: readonly vscode.Range[] = [];
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor !== undefined && textEditor.document.uri.toString() === doc.uri.toString()) {
			dontDeleteRanges = textEditor.selections;
		}

		formatTables(doc, tableLines, dontDeleteRanges);
	}, undefined, context.subscriptions);

	context.subscriptions.push(vscode.commands.registerCommand('ustab.insertCellSeparator', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor === undefined) return;

		textEditor.edit((eb: vscode.TextEditorEdit) => {
			for (const selection of textEditor.selections) {
				eb.replace(selection, cellSeparator);
			}
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('ustab.formatTable', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor === undefined) return;
		formatTables(textEditor.document, getTableLines(textEditor, cellSeparator), []);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('formatAllTables', (doc: vscode.TextDocument | undefined) => {
		if (doc === undefined) {
			const textEditor = vscode.window.activeTextEditor;
			if (textEditor === undefined) return;
			doc = textEditor.document;
		}

		const tableLines = new Set<number>();
		for (let line = 0; line <= doc.lineCount; ++line) {
			addTableLine(doc, line, cellSeparator, 1, tableLines);
		}

		formatTables(doc, tableLines, []);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('ustab.bakeTable', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor === undefined) return;
		replaceAll(textEditor.document, cellSeparator, bakeString, getTableLines(textEditor, cellSeparator));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('ustab.unbakeTable', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor === undefined) return;
		replaceAll(textEditor.document, bakeString, cellSeparator, getTableLines(textEditor, bakeString));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('ustab.removeCellSeparators', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor === undefined) return;
		replaceAll(textEditor.document, cellSeparator, '', getTableLines(textEditor, cellSeparator));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('ustab.bakeAllTables', (doc: vscode.TextDocument | undefined) => {
		if (doc === undefined) {
			const textEditor = vscode.window.activeTextEditor;
			if (textEditor === undefined) return;
			doc = textEditor.document;
		}

		replaceAll(doc, cellSeparator, bakeString, undefined);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('ustab.unbakeAllTables', (doc: vscode.TextDocument | undefined) => {
		if (doc === undefined) {
			const textEditor = vscode.window.activeTextEditor;
			if (textEditor === undefined) return;
			doc = textEditor.document;
		}

		replaceAll(doc, bakeString, cellSeparator, undefined);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('ustab.removeCellSeparatorsAllTables', (doc: vscode.TextDocument | undefined) => {
		if (doc === undefined) {
			const textEditor = vscode.window.activeTextEditor;
			if (textEditor === undefined) return;
			doc = textEditor.document;
		}

		replaceAll(doc, cellSeparator, '', undefined);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('ustab.tab', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor === undefined) return;

		const tableLines = getTableLines(textEditor, cellSeparator);
		if (tableLines.size === 0) {
			vscode.commands.executeCommand("tab");
		} else {
			const newSelections: vscode.Selection[] = [];
			
			for (const line of tableLines) {
				let selectNextCell = false;
				for (const cell of cells(textEditor.document, line)) {
					let isActiveCell = false;
					const cellRangeFull = cell.range();
					for (const selection of textEditor.selections) {
						if (cellRangeFull.contains(selection.end)) {
							isActiveCell = true;
							break;
						}
					}

					if (selectNextCell || isActiveCell && cell.isFinalCell) {
						newSelections.push(cell.textRange());
					}

					selectNextCell = isActiveCell;
				}
			}
			
			if (newSelections.length > 0) {
			    textEditor.selections = newSelections;
			}
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('ustab.outdent', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor === undefined) return;
		
		const tableLines = getTableLines(textEditor, cellSeparator);
		if (tableLines.size === 0) {
			vscode.commands.executeCommand("outdent");
		} else {
			const newSelections: vscode.Selection[] = [];
			
			for (const line of tableLines) {
				let prevCell: Cell | null = null;
				for (const cell of cells(textEditor.document, line)) {
					const cellRange = cell.range();
					for (const selection of textEditor.selections) {
						if (cellRange.contains(selection.end)) {
							if (prevCell === null) prevCell = cell;
							newSelections.push(prevCell.textRange());
							break;
						}
					}
					prevCell = cell;
				}
			}
			
			if (newSelections.length > 0) {
			    textEditor.selections = newSelections;
			}
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('ustab.cursorLeft', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor === undefined) return;
		
		const tableLines = getTableLines(textEditor, cellSeparator);
		if (tableLines.size === 0) {
			vscode.commands.executeCommand("cursorLeft");
		} else {
            const newSelections: vscode.Selection[] = [];
			const nonTableSelections: vscode.Selection[] = [];

			for (const selection of textEditor.selections) {
				if (selection.start.line !== selection.end.line || selection.start.character !== selection.end.character) {
                    newSelections.push(new vscode.Selection(selection.start.line, selection.start.character, selection.start.line, selection.start.character));
				} else {
					const cursor = selection.start;
					const cell = currentCell(textEditor.document, cursor);
					if (cursor.character > cell.textEndOffset) {
						newSelections.push(new vscode.Selection(cursor.line, cell.textEndOffset, cursor.line, cell.textEndOffset));
					} else {
						nonTableSelections.push(selection);
					}
				}
			}

            if (nonTableSelections.length > 0) {
				textEditor.selections = nonTableSelections;
				vscode.commands.executeCommand('cursorLeft').then(() => {
					textEditor.selections = [...newSelections, ...textEditor.selections];
				});
			} else if (newSelections.length > 0) {
			    textEditor.selections = newSelections;
			}
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('ustab.cursorLeftSelect', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor === undefined) return;
		
		const tableLines = getTableLines(textEditor, cellSeparator);
		if (tableLines.size === 0) {
			vscode.commands.executeCommand("cursorLeftSelect");
		} else {
            const newSelections: vscode.Selection[] = [];
			const nonTableSelections: vscode.Selection[] = [];

			for (const selection of textEditor.selections) {
				const cursor = selection.active;
				const cell = currentCell(textEditor.document, cursor);
				if (cursor.character > cell.textEndOffset) {
					newSelections.push(new vscode.Selection(selection.anchor, new vscode.Position(cursor.line, cell.textEndOffset)));
				} else {
					nonTableSelections.push(selection);
				}
			}

            if (nonTableSelections.length > 0) {
				textEditor.selections = nonTableSelections;
				vscode.commands.executeCommand('cursorLeftSelect').then(() => {
					textEditor.selections = [...newSelections, ...textEditor.selections];
				});
			} else if (newSelections.length > 0) {
			    textEditor.selections = newSelections;
			}
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('ustab.cursorRight', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor === undefined) return;
		
		const tableLines = getTableLines(textEditor, cellSeparator);
		if (tableLines.size === 0) {
			vscode.commands.executeCommand("cursorRight");
		} else {
			const newSelections: vscode.Selection[] = [];
			const nonTableSelections: vscode.Selection[] = [];
			
			for (const selection of textEditor.selections) {
				if (selection.start.line !== selection.end.line || selection.start.character !== selection.end.character) {
                    newSelections.push(new vscode.Selection(selection.end.line, selection.end.character, selection.end.line, selection.end.character));
				} else {
					const cursor = selection.start;
					const cell = currentCell(textEditor.document, cursor);
					if (cursor.character >= cell.textEndOffset && cursor.character < cell.endOffset) {
						newSelections.push(new vscode.Selection(cursor.line, cell.endOffset, cursor.line, cell.endOffset));
					} else {
						nonTableSelections.push(selection);
					}
				}
			}

            if (nonTableSelections.length > 0) {
				textEditor.selections = nonTableSelections;
				vscode.commands.executeCommand('cursorRight').then(() => {
					textEditor.selections = [...newSelections, ...textEditor.selections];
				});
			} else if (newSelections.length > 0) {
			    textEditor.selections = newSelections;
			}
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('ustab.cursorRightSelect', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor === undefined) return;
		
		const tableLines = getTableLines(textEditor, cellSeparator);
		if (tableLines.size === 0) {
			vscode.commands.executeCommand("cursorRightSelect");
		} else {
			const newSelections: vscode.Selection[] = [];
			const nonTableSelections: vscode.Selection[] = [];
			
			for (const selection of textEditor.selections) {
				const cursor = selection.active;
				const cell = currentCell(textEditor.document, cursor);
				if (cursor.character >= cell.textEndOffset && cursor.character < cell.endOffset) {
					newSelections.push(new vscode.Selection(selection.anchor, new vscode.Position(cursor.line, cell.endOffset)));
				} else {
					nonTableSelections.push(selection);
				}
			}

            if (nonTableSelections.length > 0) {
				textEditor.selections = nonTableSelections;
				vscode.commands.executeCommand('cursorRightSelect').then(() => {
					textEditor.selections = [...newSelections, ...textEditor.selections];
				});
			} else if (newSelections.length > 0) {
			    textEditor.selections = newSelections;
			}
		}
	}));
}

export function deactivate() {}
