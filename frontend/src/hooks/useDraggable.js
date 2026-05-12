import { useState, useRef, useEffect } from 'react';

export function useDraggable(visible = true) {
    const [pos, setPos]           = useState({ x: 0, y: 0 });
    const [dragging, setDragging] = useState(false);
    const drag = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });

    useEffect(() => {
        if (visible) setPos({ x: 0, y: 0 });
    }, [visible]);

    useEffect(() => {
        function onMouseMove(e) {
            if (!drag.current.active) return;
            setPos({
                x: drag.current.originX + (e.clientX - drag.current.startX),
                y: drag.current.originY + (e.clientY - drag.current.startY),
            });
        }
        function onMouseUp() {
            if (!drag.current.active) return;
            drag.current.active = false;
            setDragging(false);
        }
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        return () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
    }, []);

    function onDragStart(e) {
        if (e.button !== 0) return;
        drag.current = { active: true, startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y };
        setDragging(true);
        e.preventDefault();
    }

    return {
        dragging,
        onDragStart,
        dragStyle:      { cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none' },
        containerStyle: { transform: `translate(${pos.x}px, ${pos.y}px)`, willChange: 'transform' },
        overlayStyle:   { userSelect: dragging ? 'none' : 'auto' },
    };
}
