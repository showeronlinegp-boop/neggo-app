const jwt = require('jsonwebtoken');
const { fail } = require('../utils/response');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

// Middleware: verificar JWT en el header Authorization
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return fail(res, 'Token no proporcionado', 401);
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = {
            id: decoded.id,
            username: decoded.username,
            role: decoded.role
        };
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return fail(res, 'Token expirado', 401);
        }
        return fail(res, 'Token inválido', 401);
    }
}

// Middleware factory: verificar que el usuario tiene uno de los roles permitidos
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return fail(res, 'No autenticado', 401);
        }
        if (!roles.includes(req.user.role)) {
            return fail(res, 'Acceso denegado. Rol requerido: ' + roles.join(' o '), 403);
        }
        next();
    };
}

// Generar token JWT
function generateToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: '24h' }
    );
}

module.exports = { authenticate, requireRole, generateToken };
