import React from 'react';

function PlainSecretField({ id, label, value, onChange, placeholder }) {
  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="plain-secret"
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        data-form-type="other"
      />
      <div className="secret-preview">
        当前明文：<strong className="secret-visible">{value === '' ? '（空）' : value}</strong>
      </div>
    </div>
  );
}

export default PlainSecretField;
