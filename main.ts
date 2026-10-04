import { Plugin } from 'obsidian';

const TABLE_SELECTOR = '.markdown-reading-view table, .markdown-preview-view table, .cm-table-widget table';
const EXCLUDED_SELECTOR = '.tsh-clone-wrapper, .markmap, [data-type="myMarkmap"], foreignObject';

interface StickyTable {
    update: () => void;
    invalidate: () => void;
    isCurrent: () => boolean;
    cleanup: () => void;
}

export default class TableStickyHeaderPlugin extends Plugin {
    private mutationObserver: MutationObserver | null = null;
    private tables = new Map<HTMLTableElement, StickyTable>();
    private pendingTables = new Set<HTMLTableElement>();
    private dirtyTables = new Set<HTMLTableElement>();
    private frameId: number | null = null;
    private checkRemovedTables = false;
    private unloaded = false;

    onload() {
        this.mutationObserver = new MutationObserver((records) => this.onMutations(records));
        this.mutationObserver.observe(document.body, { childList: true, subtree: true });

        this.app.workspace.onLayoutReady(() => {
            if (this.unloaded) return;
            document.querySelectorAll<HTMLTableElement>(TABLE_SELECTOR).forEach((table) => {
                this.pendingTables.add(table);
            });
            if (this.pendingTables.size) this.scheduleFrame();
        });

        const invalidateLayout = () => {
            this.tables.forEach((state) => state.invalidate());
        };
        this.registerEvent(this.app.workspace.on('layout-change', invalidateLayout));
        this.registerEvent(this.app.workspace.on('active-leaf-change', invalidateLayout));
        this.registerDomEvent(window, 'resize', invalidateLayout);
    }

    onunload() {
        this.unloaded = true;
        this.mutationObserver?.disconnect();
        if (this.frameId !== null) cancelAnimationFrame(this.frameId);
        this.frameId = null;
        this.tables.forEach((state) => state.cleanup());
        this.tables.clear();
        this.pendingTables.clear();
        this.dirtyTables.clear();
    }

    private onMutations(records: MutationRecord[]) {
        for (const record of records) {
            // Text replacement is common during typing. It cannot introduce or
            // remove a table, and table-local observers handle header text edits.
            if (!Array.from(record.addedNodes).some((node) => node instanceof Element) &&
                !Array.from(record.removedNodes).some((node) => node instanceof Element)) continue;
            const target = record.target as Element;
            if (target.closest(EXCLUDED_SELECTOR)) continue;

            // Content changes in existing tables have their own observer. Ordinary
            // text edits do not require a document scan or a geometry update.
            const table = target.closest<HTMLTableElement>('table');
            if (table && !this.tables.has(table)) this.pendingTables.add(table);

            for (const node of Array.from(record.addedNodes)) {
                if (!(node instanceof Element) || node.closest(EXCLUDED_SELECTOR)) continue;
                if (node.matches('table')) this.pendingTables.add(node as HTMLTableElement);
                node.querySelectorAll<HTMLTableElement>('table').forEach((addedTable) => {
                    this.pendingTables.add(addedTable);
                });
            }
            if (this.tables.size && !this.checkRemovedTables) {
                for (const node of Array.from(record.removedNodes)) {
                    if (node instanceof Element && !node.matches(EXCLUDED_SELECTOR) &&
                        (node.matches('table') || node.querySelector('table'))) {
                        this.checkRemovedTables = true;
                        break;
                    }
                }
            }
        }
        if (this.pendingTables.size || this.checkRemovedTables) this.scheduleFrame();
    }

    private scheduleUpdate(table: HTMLTableElement) {
        this.dirtyTables.add(table);
        this.scheduleFrame();
    }

    private scheduleFrame() {
        if (this.unloaded || this.frameId !== null) return;
        this.frameId = requestAnimationFrame(() => {
            this.frameId = null;
            if (this.checkRemovedTables) {
                this.checkRemovedTables = false;
                this.tables.forEach((state, table) => {
                    if (!state.isCurrent()) {
                        state.cleanup();
                        this.tables.delete(table);
                        this.dirtyTables.delete(table);
                    }
                });
            }
            const pending = Array.from(this.pendingTables);
            this.pendingTables.clear();
            for (const table of pending) {
                if (table.isConnected && table.matches(TABLE_SELECTOR) &&
                    !table.closest(EXCLUDED_SELECTOR) && !this.tables.has(table)) {
                    this.setupStickyHeader(table);
                }
            }
            const dirty = Array.from(this.dirtyTables);
            this.dirtyTables.clear();
            for (const table of dirty) this.tables.get(table)?.update();
        });
    }

    private setupStickyHeader(table: HTMLTableElement) {
        let thead = table.querySelector('thead');
        const scrollContainer = this.findVerticalScrollContainer(table);
        if (!thead || !scrollContainer) return;
        const hScrollContainer = this.findHorizontalScrollContainer(table);

        const wrapper = document.createElement('div');
        wrapper.className = 'tsh-clone-wrapper';
        const scroller = document.createElement('div');
        scroller.className = 'tsh-clone-scroller';
        wrapper.appendChild(scroller);

        // The body is never displayed; cloning it wastes work on long tables.
        const clonedTable = table.cloneNode(false) as HTMLTableElement;
        clonedTable.removeAttribute('data-sticky-header-initialized');
        scroller.appendChild(clonedTable);
        document.body.appendChild(wrapper);

        let headerDirty = true;
        let widthsDirty = true;
        let boundaryHeight = -1;
        let boundaryObserver: IntersectionObserver | null = null;
        const schedule = () => this.scheduleUpdate(table);
        const invalidate = () => {
            widthsDirty = true;
            schedule();
        };
        const resizeObserver = new ResizeObserver(invalidate);
        resizeObserver.observe(table);
        resizeObserver.observe(thead);
        resizeObserver.observe(scrollContainer);
        const leafContent = table.closest('.workspace-leaf-content');
        if (leafContent) resizeObserver.observe(leafContent);

        const contentObserver = new MutationObserver((records) => {
            headerDirty = headerDirty || records.some((record) =>
                record.target === table || thead?.contains(record.target));
            invalidate();
        });
        contentObserver.observe(table, { childList: true, subtree: true, characterData: true, attributes: true });

        const update = () => {
            if (!table.isConnected) return;
            const currentHeader = table.querySelector('thead');
            if (currentHeader !== thead) {
                if (thead) resizeObserver.unobserve(thead);
                thead = currentHeader;
                if (thead) resizeObserver.observe(thead);
                headerDirty = true;
                widthsDirty = true;
                boundaryHeight = -1;
            }
            if (!thead) {
                if (wrapper.classList.contains('tsh-visible')) wrapper.classList.remove('tsh-visible');
                boundaryObserver?.disconnect();
                return;
            }

            const tableRect = table.getBoundingClientRect();
            const theadRect = thead.getBoundingClientRect();
            const containerRect = scrollContainer.getBoundingClientRect();
            const headerHeight = theadRect.height;
            const topBoundary = containerRect.top;

            // Watch crossings caused by content above the table moving it, even
            // when neither scrolling nor a table resize occurs. The inset makes
            // the header exit at its top and the table exit at its last header-height.
            if (headerHeight !== boundaryHeight) {
                boundaryHeight = headerHeight;
                boundaryObserver?.disconnect();
                boundaryObserver = new IntersectionObserver(schedule, {
                    root: scrollContainer,
                    rootMargin: `-${headerHeight}px 0px 0px 0px`,
                });
                boundaryObserver.observe(table);
                boundaryObserver.observe(thead);
            }

            const shouldStick = headerHeight > 0 && tableRect.width > 0 &&
                theadRect.top < topBoundary && tableRect.bottom > topBoundary + headerHeight;
            if (!shouldStick) {
                if (wrapper.classList.contains('tsh-visible')) wrapper.classList.remove('tsh-visible');
                return;
            }

            const leafRect = leafContent?.getBoundingClientRect();
            const visibleLeft = leafRect ? Math.max(tableRect.left, leafRect.left) : tableRect.left;
            const visibleRight = leafRect ? Math.min(tableRect.right, leafRect.right) : tableRect.right;

            // Read all widths before writing styles, and only when invalidated.
            const widths = widthsDirty ? Array.from(thead.querySelectorAll<HTMLElement>('th, td'),
                (cell) => cell.getBoundingClientRect().width) : null;
            if (headerDirty) {
                clonedTable.replaceChildren(thead.cloneNode(true));
                headerDirty = false;
            }
            if (widths) {
                this.syncColumnWidths(clonedTable, widths, tableRect.width);
                widthsDirty = false;
            }
            this.setStyle(wrapper, 'top', `${topBoundary}px`);
            this.setStyle(wrapper, 'left', `${visibleLeft}px`);
            this.setStyle(wrapper, 'width', `${Math.max(0, visibleRight - visibleLeft)}px`);
            this.setStyle(wrapper, 'height', `${headerHeight}px`);
            this.setStyle(scroller, 'width', `${tableRect.width}px`);
            this.setStyle(scroller, 'marginLeft', `${tableRect.left - visibleLeft}px`);
            if (!wrapper.classList.contains('tsh-visible')) wrapper.classList.add('tsh-visible');
        };

        scrollContainer.addEventListener('scroll', schedule, { passive: true });
        if (hScrollContainer && hScrollContainer !== scrollContainer) {
            hScrollContainer.addEventListener('scroll', schedule, { passive: true });
        }
        this.tables.set(table, {
            update,
            invalidate,
            isCurrent: () => table.isConnected && table.matches(TABLE_SELECTOR) &&
                !table.closest(EXCLUDED_SELECTOR) &&
                this.findVerticalScrollContainer(table) === scrollContainer &&
                this.findHorizontalScrollContainer(table) === hScrollContainer &&
                table.closest('.workspace-leaf-content') === leafContent,
            cleanup: () => {
                scrollContainer.removeEventListener('scroll', schedule);
                hScrollContainer?.removeEventListener('scroll', schedule);
                resizeObserver.disconnect();
                boundaryObserver?.disconnect();
                contentObserver.disconnect();
                wrapper.remove();
            },
        });
        // Setup already runs in the shared frame, so include its first update
        // in that frame rather than scheduling a timer or another frame.
        this.dirtyTables.add(table);
    }

    private findVerticalScrollContainer(element: HTMLElement): HTMLElement | null {
        let current: HTMLElement | null = element.parentElement;
        while (current) {
            if (current.classList.contains('markdown-preview-view') ||
                current.classList.contains('cm-scroller') ||
                current.classList.contains('view-content')) {
                return current;
            }
            const style = window.getComputedStyle(current);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                current.scrollHeight > current.clientHeight) {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }

    private findHorizontalScrollContainer(element: HTMLElement): HTMLElement | null {
        let current: HTMLElement | null = element.parentElement;
        while (current) {
            const style = window.getComputedStyle(current);
            if (style.overflowX === 'auto' || style.overflowX === 'scroll') {
                return current;
            }
            if (current.classList.contains('cm-table-widget') ||
                current.classList.contains('cm-embed-block')) {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }

    private setStyle(element: HTMLElement, property: 'top' | 'left' | 'width' | 'height' | 'marginLeft' | 'minWidth' | 'maxWidth' | 'boxSizing', value: string) {
        if (element.style[property] !== value) element.style[property] = value;
    }

    private syncColumnWidths(target: HTMLTableElement, widths: number[], tableWidth: number) {
        target.querySelectorAll<HTMLElement>('thead th, thead td').forEach((cell, i) => {
            if (widths[i] === undefined) return;
            const width = `${widths[i]}px`;
            this.setStyle(cell, 'width', width);
            this.setStyle(cell, 'minWidth', width);
            this.setStyle(cell, 'maxWidth', width);
            this.setStyle(cell, 'boxSizing', 'border-box');
        });
        this.setStyle(target, 'width', `${tableWidth}px`);
        this.setStyle(target, 'minWidth', `${tableWidth}px`);
    }
}
