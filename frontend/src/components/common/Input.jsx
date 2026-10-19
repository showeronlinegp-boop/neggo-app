import { useState, forwardRef } from 'react';
import { useTheme } from '../../theme/ThemeContext';

const Input = forwardRef(function Input({ leftIcon, rightIcon, style, ...rest }, ref) {
  const { tokens: t } = useTheme();
  const [focus, setFocus] = useState(false);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      background: t.color.surface,
      border: `1px solid ${focus ? t.color.primary : t.color.borderStrong}`,
      borderRadius: t.radius.sm,
      padding: '0 12px',
      height: t.layout.inputHeight,
      transition: 'border-color 120ms, box-shadow 120ms',
      boxShadow: focus ? `0 0 0 3px ${t.color.primarySoft}` : 'none',
      ...style,
    }}>
      {leftIcon && (
        <span style={{ color: t.color.textFaint, marginRight: 8, display: 'flex', flexShrink: 0 }}>
          {leftIcon}
        </span>
      )}
      <input
        ref={ref}
        {...rest}
        onFocus={(e) => { setFocus(true); rest.onFocus?.(e); }}
        onBlur={(e) => { setFocus(false); rest.onBlur?.(e); }}
        style={{
          border: 'none',
          outline: 'none',
          background: 'transparent',
          flex: 1,
          minWidth: 0,
          height: '100%',
          color: t.color.text,
          fontSize: t.font.size.base,
          fontFamily: t.font.family,
        }}
      />
      {rightIcon && (
        <span style={{ color: t.color.textFaint, marginLeft: 8, display: 'flex', flexShrink: 0 }}>
          {rightIcon}
        </span>
      )}
    </div>
  );
});

export default Input;
