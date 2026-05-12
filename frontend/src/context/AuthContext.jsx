import { createContext, useContext, useState, useEffect } from 'react';
import api from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    // Al montar, verificar si hay token guardado
    useEffect(() => {
        const token = api.getToken();
        if (token) {
            verifyToken();
        } else {
            setLoading(false);
        }
    }, []);

    async function verifyToken() {
        try {
            const res = await api.get('/auth/me');
            if (res.success) {
                setUser(res.data);
            } else {
                api.removeToken();
            }
        } catch {
            api.removeToken();
        } finally {
            setLoading(false);
        }
    }

    async function login(username, password) {
        const res = await api.post('/auth/login', { username, password });
        if (res.success) {
            api.setToken(res.data.token);
            setUser(res.data.user);
            return { success: true };
        }
        return { success: false, error: res.error };
    }

    function logout() {
        api.removeToken();
        setUser(null);
    }

    return (
        <AuthContext.Provider value={{ user, loading, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth debe usarse dentro de un AuthProvider');
    }
    return context;
}
