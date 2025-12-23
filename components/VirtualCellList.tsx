import React, { forwardRef } from 'react';
import { Cell } from '../types';
import { Virtuoso, VirtuosoHandle, ListRange } from 'react-virtuoso';

interface Props {
  cells: Cell[];
  renderCell: (cell: Cell, index: number) => React.ReactNode;
  virtuosoRef?: React.RefObject<VirtuosoHandle>;
  className?: string;
  onRangeChange?: (range: ListRange) => void;
}

// Custom Scroller to ensure layout matches previous design (Max width centered)
const ListContainer = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
  <div
    {...props}
    ref={ref}
    className="max-w-5xl mx-auto px-4 pt-4"
  />
));

// Footer component to add bottom padding so last cell isn't cut off
const Footer = () => <div className="h-32" />;

export const VirtualCellList: React.FC<Props> = ({ cells, renderCell, virtuosoRef, className, onRangeChange }) => {
  return (
    <Virtuoso
      ref={virtuosoRef}
      className={className}
      data={cells}
      useWindowScroll={false}
      totalCount={cells.length}
      itemContent={(index, cell) => renderCell(cell, index)}
      // Use stable cell IDs as keys to prevent scroll jumps when cells update
      computeItemKey={(index, cell) => cell.id}
      overscan={1000}
      // Increase viewport by 2000px in each direction to render cells earlier
      // This prevents scroll jumps when scrolling back to long cells that were
      // previously estimated but now need to be measured
      increaseViewportBy={{ top: 2000, bottom: 2000 }}
      components={{
        List: ListContainer,
        Footer
      }}
      followOutput={false}
      alignToBottom={false}
      rangeChanged={onRangeChange}
    />
  );
};