import React, { forwardRef } from 'react';
import { Cell } from '../types';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';

interface Props {
  cells: Cell[];
  renderCell: (cell: Cell, index: number) => React.ReactNode;
  virtuosoRef?: React.RefObject<VirtuosoHandle>;
  className?: string;
}

// Custom Scroller to ensure layout matches previous design (Max width centered)
const ListContainer = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
  <div 
    {...props} 
    ref={ref} 
    className="max-w-5xl mx-auto px-4 py-8 pb-32"
  />
));

export const VirtualCellList: React.FC<Props> = ({ cells, renderCell, virtuosoRef, className }) => {
  return (
    <Virtuoso
      ref={virtuosoRef}
      className={className}
      data={cells}
      useWindowScroll={false} // We are using a flex container
      totalCount={cells.length}
      itemContent={(index, cell) => renderCell(cell, index)}
      overscan={500} // Pre-render more content to reduce white flashes
      components={{
        List: ListContainer
      }}
      // Ensure smooth scrolling behaviors
      followOutput={false}
      alignToBottom={false}
    />
  );
};