// Cliente HTTP para la API con JWT automático

const BASE_URL = '/api';

function getToken() {
    return localStorage.getItem('neggo_token');
}

function setToken(token) {
    localStorage.setItem('neggo_token', token);
}

function removeToken() {
    localStorage.removeItem('neggo_token');
}

async function request(method, url, body = null) {
    const token = getToken();
    const isFormData = body instanceof FormData;
    const headers = {};

    if (!isFormData) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const options = { method, headers };

    if (body && method !== 'GET') {
        options.body = isFormData ? body : JSON.stringify(body);
    }

    try {
        const response = await fetch(`${BASE_URL}${url}`, options);

        // Si 401, limpiar sesión y redirigir a login
        if (response.status === 401) {
            removeToken();
            window.location.href = '/login';
            return { success: false, error: 'Sesión expirada' };
        }

        const data = await response.json();
        return data;
    } catch (error) {
        console.error('❌ Error de red:', error.message);
        return { success: false, error: 'Error de conexión con el servidor' };
    }
}

// Construir query string desde objeto de filtros
function buildQuery(params) {
    const filtered = Object.entries(params || {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (filtered.length === 0) return '';
    return '?' + filtered.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

const api = {
    get:   (url, params) => request('GET',    url + buildQuery(params)),
    post:  (url, body)   => request('POST',   url, body),
    put:   (url, body)   => request('PUT',    url, body),
    patch: (url, body)   => request('PATCH',  url, body),
    del:   (url)         => request('DELETE', url),
    setToken,
    getToken,
    removeToken
};

export default api;
