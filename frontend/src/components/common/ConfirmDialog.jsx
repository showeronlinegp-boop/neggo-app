import { useTheme } from '../../theme/ThemeContext';
import Modal from './Modal';
import Button from './Button';

export default function ConfirmDialog({
    isOpen,
    onClose,
    onConfirm,
    title = '¿Estás seguro?',
    message,
    confirmLabel = 'Confirmar',
    danger = false,
}) {
    const { tokens: t } = useTheme();

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={title}
            size="sm"
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>Cancelar</Button>
                    <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
                        {confirmLabel}
                    </Button>
                </>
            }
        >
            <p style={{
                fontSize: t.font.size.base,
                color: t.color.text,
                margin: 0,
                lineHeight: 1.5,
                fontFamily: t.font.family,
            }}>
                {message}
            </p>
        </Modal>
    );
}
