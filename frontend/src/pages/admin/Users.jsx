import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import DataTable from '../../components/common/DataTable';
import Modal from '../../components/common/Modal';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import Toggle from '../../components/common/Toggle';
import * as Icon from '../../components/common/icons';

const ROLES = ['admin', 'operador', 'vendedor'];
const ROLE_OPTIONS = ROLES.map(r => ({ value: r, label: r }));

function roleTone(r) {
    if (r === 'admin')    return 'danger';
    if (r === 'operador') return 'primary';
    return 'muted';
}

export default function Users() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();

    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [modal, setModal] = useState(null);
    const [deactivating, setDeactivating] = useState(null);
    const [saving, setSaving] = useState(false);

    const [username, setUsername] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [role, setRole] = useState('operador');
    const [password, setPassword] = useState('');
    const [active, setActive] = useState(true);

    useEffect(() => { fetchData(); }, [page]);

    async function fetchData() {
        setLoading(true);
        const res = await api.get('/users', { limit: 20, offset: (page - 1) * 20 });
        if (res.success) { setData(res.data || []); setTotal(res.pagination?.total || res.data?.length || 0); }
        else showToast(res.error || 'Error al cargar usuarios', 'error');
        setLoading(false);
    }

    function openNew() {
        setUsername(''); setDisplayName(''); setRole('operador'); setPassword(''); setActive(true);
        setModal('new');
    }

    function openEdit(user) {
        setUsername(user.username); setDisplayName(user.display_name);
        setRole(user.role); setPassword(''); setActive(user.active);
        setModal(user);
    }

    async function handleSave() {
        if (modal === 'new') {
            if (!username.trim() || !displayName.trim() || !password)
                return showToast('Username, nombre y contraseña son obligatorios', 'warning');
        } else {
            if (!displayName.trim()) return showToast('El nombre es obligatorio', 'warning');
        }
        setSaving(true);
        let res;
        if (modal === 'new') {
            res = await api.post('/users', { username: username.trim(), displayName: displayName.trim(), role, password });
        } else {
            const body = { displayName: displayName.trim(), role, active };
            if (password) body.password = password;
            res = await api.put(`/users/${modal.id}`, body);
        }
        setSaving(false);
        if (res.success) { showToast(modal === 'new' ? 'Usuario creado' : 'Usuario actualizado', 'success'); setModal(null); fetchData(); }
        else showToast(res.error || 'Error al guardar', 'error');
    }

    async function handleDeactivate() {
        const res = await api.del(`/users/${deactivating.id}`);
        setDeactivating(null);
        if (res.success) { showToast('Usuario desactivado', 'success'); fetchData(); }
        else showToast(res.error || 'Error al desactivar', 'error');
    }

    const labelStyle = {
        display: 'block', fontSize: t.font.size.sm,
        fontWeight: t.font.weight.medium, color: t.color.textMuted,
        marginBottom: t.space[1], fontFamily: t.font.family,
    };

    const cols = [
        {
            key: 'username',
            label: 'Usuario',
            render: v => (
                <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textMuted }}>
                    {v}
                </span>
            ),
        },
        { key: 'display_name', label: 'Nombre' },
        {
            key: 'role',
            label: 'Rol',
            render: v => <Badge tone={roleTone(v)}>{v}</Badge>,
        },
        {
            key: 'active',
            label: 'Estado',
            render: v => <Badge tone={v ? 'success' : 'muted'} dot>{v ? 'Activo' : 'Inactivo'}</Badge>,
        },
        {
            key: 'created_at',
            label: 'Creado',
            render: v => (
                <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                    {new Date(v).toLocaleDateString('es-AR')}
                </span>
            ),
        },
        {
            key: 'id',
            label: '',
            render: (_, row) => (
                <div style={{ display: 'flex', gap: t.space[2] }}>
                    <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); openEdit(row); }}>
                        Editar
                    </Button>
                    {row.active && (
                        <Button size="sm" variant="danger" onClick={e => { e.stopPropagation(); setDeactivating(row); }}>
                            Desactivar
                        </Button>
                    )}
                </div>
            ),
        },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="primary" leftIcon={<Icon.Users size={15} />} onClick={openNew}>
                    Nuevo usuario
                </Button>
            </div>

            <DataTable
                columns={cols}
                data={data}
                loading={loading}
                pagination={{ page, pageSize: 20, total }}
                onPageChange={setPage}
            />

            <Modal
                isOpen={!!modal}
                onClose={() => setModal(null)}
                title={modal === 'new' ? 'Nuevo usuario' : `Editar: ${modal?.display_name}`}
                size="sm"
                footer={
                    <>
                        <Button variant="ghost" onClick={() => setModal(null)}>Cancelar</Button>
                        <Button variant="primary" disabled={saving} onClick={handleSave}>
                            {saving ? 'Guardando…' : 'Guardar'}
                        </Button>
                    </>
                }
            >
                <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>
                    <div>
                        <label style={labelStyle}>Username *</label>
                        <Input
                            value={username}
                            onChange={e => setUsername(e.target.value)}
                            placeholder="Ej: jperez"
                            disabled={modal !== 'new'}
                        />
                    </div>
                    <div>
                        <label style={labelStyle}>Nombre completo *</label>
                        <Input
                            value={displayName}
                            onChange={e => setDisplayName(e.target.value)}
                            placeholder="Ej: Juan Pérez"
                        />
                    </div>
                    <div>
                        <label style={labelStyle}>Rol</label>
                        <Select value={role} onChange={setRole} options={ROLE_OPTIONS} />
                    </div>
                    <div>
                        <label style={labelStyle}>
                            {modal === 'new' ? 'Contraseña *' : 'Nueva contraseña (vacío para no cambiar)'}
                        </label>
                        <Input
                            type="password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            placeholder={modal === 'new' ? 'Contraseña segura' : '••••••••'}
                        />
                    </div>
                    {modal !== 'new' && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: t.space[3], cursor: 'pointer', fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>
                            <Toggle checked={active} onChange={setActive} size="sm" />
                            Usuario activo
                        </label>
                    )}
                </div>
            </Modal>

            <ConfirmDialog
                isOpen={!!deactivating}
                onClose={() => setDeactivating(null)}
                onConfirm={handleDeactivate}
                title="Desactivar usuario"
                message={`¿Desactivás a "${deactivating?.display_name}" (${deactivating?.username})? Va a perder acceso al sistema.`}
                confirmLabel="Desactivar"
                danger
            />
        </div>
    );
}
