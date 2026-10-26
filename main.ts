import { Plugin } from 'obsidian';

/**
 * Table Sticky Header Plugin
 * 
 * 修复问题：
 * 1. 宽度对齐 - 使用 getBoundingClientRect 精确同步
 * 2. 样式一致 - 继承原表格样式
 * 3. 横向滚动 - 克隆容器跟随水平滚动容器，而非 translateX
 * 4. 窄表格 - 克隆容器宽度跟随表格实际宽度
 */
export default class TableStickyHeaderPlugin extends Plugin {
    private mutationObserver: MutationObserver | null = null;
    private processedTables: WeakSet<HTMLTableElement> = new WeakSet();
    private cleanupFunctions: Map<HTMLTableElement, () => void> = new Map();

    async onload() {
        this.app.workspace.onLayoutReady(() => {
            this.processAllTables();
        });

        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                setTimeout(() => this.processAllTables(), 200);
            })
        );

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                setTimeout(() => this.processAllTables(), 200);
            })
        );

        this.mutationObserver = new MutationObserver(() => {
            this.processAllTables();
        });

        this.mutationObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    onunload() {
        this.cleanupFunctions.forEach((cleanup) => cleanup());
        this.cleanupFunctions.clear();
        document.querySelectorAll('.tsh-clone-wrapper').forEach((el) => el.remove());
        this.mutationObserver?.disconnect();
    }

    private processAllTables() {
        const tables = document.querySelectorAll<HTMLTableElement>(
            '.markdown-reading-view table, .markdown-preview-view table, .cm-table-widget table'
        );

        tables.forEach((table) => {
            if (!this.processedTables.has(table) && !table.closest('.tsh-clone-wrapper')) {
                // Skip tables inside markmap views (side panel SVG or inline markmap)
                if (table.closest('.markmap') || table.closest('[data-type="myMarkmap"]') || table.closest('foreignObject')) return;
                this.setupStickyHeader(table);
                this.processedTables.add(table);
            }
        });
    }

    private setupStickyHeader(table: HTMLTableElement) {
        const thead = table.querySelector('thead');
        if (!thead) return;

        // 找到滚动容器
        const scrollContainer = this.findVerticalScrollContainer(table);
        if (!scrollContainer) return;

        // 找到水平滚动的父容器
        const hScrollContainer = this.findHorizontalScrollContainer(table);

        // 创建克隆结构
        const wrapper = document.createElement('div');
        wrapper.className = 'tsh-clone-wrapper';

        const scroller = document.createElement('div');
        scroller.className = 'tsh-clone-scroller';
        wrapper.appendChild(scroller);

        // Clone only the header. Cloning the body and hiding it with CSS still
        // leaves the body's row in the table layout, which creates a blank row
        // below the sticky header in Reading view.
        const clonedTable = document.createElement('table');
        clonedTable.className = table.className;
        clonedTable.removeAttribute('data-sticky-header-initialized');
        clonedTable.appendChild(thead.cloneNode(true));
        scroller.appendChild(clonedTable);

        document.body.appendChild(wrapper);

        // 更新逻辑
        const update = () => {
            // 检查表格是否还在 DOM 中
            if (!document.body.contains(table)) {
                wrapper.classList.remove('tsh-visible');
                return;
            }

            const tableRect = table.getBoundingClientRect();
            const theadRect = thead.getBoundingClientRect();
            const containerRect = scrollContainer.getBoundingClientRect();

            // 获取当前 leaf 容器，确保不超出范围
            const leafContent = table.closest('.workspace-leaf-content');
            const leafRect = leafContent?.getBoundingClientRect();

            const headerHeight = theadRect.height;
            const topBoundary = containerRect.top;

            // 判断是否需要 sticky
            const shouldStick = theadRect.top < topBoundary &&
                tableRect.bottom > topBoundary + headerHeight;

            if (shouldStick) {
                wrapper.classList.add('tsh-visible');

                // 同步列宽（精确复制每个单元格宽度）
                this.syncColumnWidths(table, clonedTable);

                // Clip the clone to the same horizontal viewport as the table.
                // Using only the table bounds lets the clone paint outside the
                // visible side of a horizontally scrollable table.
                const horizontalRect = hScrollContainer?.getBoundingClientRect();
                const clipLeft = Math.max(
                    horizontalRect?.left ?? -Infinity,
                    leafRect?.left ?? -Infinity,
                    0
                );
                const clipRight = Math.min(
                    horizontalRect?.right ?? Infinity,
                    leafRect?.right ?? Infinity,
                    window.innerWidth
                );
                const visibleLeft = Math.max(tableRect.left, clipLeft);
                const visibleRight = Math.min(tableRect.right, clipRight);
                const visibleWidth = Math.max(0, visibleRight - visibleLeft);

                // The cloned header no longer has the first body row beneath
                // it. Recreate that row's separator on the floating wrapper so
                // the transition from header to body remains visible.
                const firstBodyCell = table.querySelector('tbody tr td, tbody tr th');
                const separatorSource = firstBodyCell ?? table.querySelector('thead th, thead td');
                if (separatorSource) {
                    const separatorStyle = window.getComputedStyle(separatorSource);
                    const width = separatorStyle.getPropertyValue('border-top-width');
                    const style = separatorStyle.getPropertyValue('border-top-style');
                    const color = separatorStyle.getPropertyValue('border-top-color');
                    wrapper.style.borderBottom = `${width} ${style} ${color}`;
                }

                wrapper.style.top = `${topBoundary}px`;
                wrapper.style.left = `${visibleLeft}px`;
                wrapper.style.width = `${visibleWidth}px`;
                wrapper.style.height = `${headerHeight}px`;

                scroller.style.width = `${tableRect.width}px`;
                scroller.style.marginLeft = `${tableRect.left - visibleLeft}px`;

            } else {
                wrapper.classList.remove('tsh-visible');
            }
        };

        // 事件处理
        const scrollHandler = () => requestAnimationFrame(update);

        scrollContainer.addEventListener('scroll', scrollHandler, { passive: true });
        if (hScrollContainer && hScrollContainer !== scrollContainer) {
            hScrollContainer.addEventListener('scroll', scrollHandler, { passive: true });
        }
        window.addEventListener('resize', scrollHandler, { passive: true });

        // 定期检查（应对动态内容变化）
        const intervalId = setInterval(update, 500);

        // 初始更新
        setTimeout(update, 100);

        // 清理函数
        this.cleanupFunctions.set(table, () => {
            scrollContainer.removeEventListener('scroll', scrollHandler);
            if (hScrollContainer) {
                hScrollContainer.removeEventListener('scroll', scrollHandler);
            }
            window.removeEventListener('resize', scrollHandler);
            clearInterval(intervalId);
            wrapper.remove();
        });
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

    private syncColumnWidths(source: HTMLTableElement, target: HTMLTableElement) {
        // The clone lives under document.body, so editor-scoped selectors no
        // longer apply. Copy the computed visual styles instead of imposing a
        // replacement theme on the sticky header.
        const visualProperties = [
            'text-align', 'vertical-align', 'font-family', 'font-size',
            'font-weight', 'font-style', 'line-height', 'letter-spacing',
            'text-transform', 'padding-top', 'padding-right', 'padding-bottom',
            'padding-left', 'color', 'background-color', 'background-image',
            'background-size', 'background-position', 'background-repeat',
            'white-space', 'border-collapse', 'border-spacing', 'box-sizing',
            'border-top-width', 'border-top-style', 'border-top-color',
            'border-right-width', 'border-right-style', 'border-right-color',
            'border-bottom-width', 'border-bottom-style', 'border-bottom-color',
            'border-left-width', 'border-left-style', 'border-left-color'
        ];
        const copyStyles = (from: Element, to: HTMLElement) => {
            const computed = window.getComputedStyle(from);
            for (const property of visualProperties) {
                to.style.setProperty(property, computed.getPropertyValue(property));
            }
        };

        copyStyles(source, target);
        const sourceHead = source.querySelector('thead');
        const targetHead = target.querySelector('thead');
        if (sourceHead && targetHead) {
            copyStyles(sourceHead, targetHead as HTMLElement);
        }

        const sourceRows = source.querySelectorAll('thead tr');
        const targetRows = target.querySelectorAll('thead tr');
        sourceRows.forEach((row, i) => {
            if (targetRows[i]) copyStyles(row, targetRows[i] as HTMLElement);
        });

        const sourceCells = source.querySelectorAll('thead th, thead td');
        const targetCells = target.querySelectorAll('thead th, thead td');
        sourceCells.forEach((cell, i) => {
            if (targetCells[i]) {
                const rect = (cell as HTMLElement).getBoundingClientRect();
                const targetCell = targetCells[i] as HTMLElement;
                copyStyles(cell, targetCell);
                targetCell.style.setProperty('width', `${rect.width}px`);
                targetCell.style.setProperty('min-width', `${rect.width}px`);
                targetCell.style.setProperty('max-width', `${rect.width}px`);
                targetCell.style.setProperty('box-sizing', 'border-box');
            }
        });

        const sourceRect = source.getBoundingClientRect();
        target.style.setProperty('width', `${sourceRect.width}px`);
        target.style.setProperty('min-width', `${sourceRect.width}px`);
    }
}
