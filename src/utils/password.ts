// Pure JavaScript password hashing utility using Web Crypto API
// Compatible with Deno Deploy (no FFI or WASM required)

const ITERATIONS = 100000; // OWASP recommended minimum for PBKDF2
const KEY_LENGTH = 32; // 256 bits
const SALT_LENGTH = 16; // 128 bits

/**
 * Generates a cryptographically secure random salt
 */
function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * Converts a Uint8Array or ArrayBuffer to a base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts a base64 string to a Uint8Array
 */
function base64ToArrayBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Derives a key from a password using PBKDF2
 */
async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<ArrayBuffer> {
  const passwordBuffer = new TextEncoder().encode(password);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passwordBuffer,
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  return await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    KEY_LENGTH * 8, // Convert to bits
  );
}

/**
 * Hashes a password with a random salt
 * Returns a string in the format: iterations$salt$hash (all base64 encoded)
 */
export async function hash(password: string): Promise<string> {
  const salt = generateSalt();
  const derivedKey = await deriveKey(password, salt);

  const saltBase64 = arrayBufferToBase64(salt);
  const hashBase64 = arrayBufferToBase64(derivedKey);

  return `${ITERATIONS}$${saltBase64}$${hashBase64}`;
}

/**
 * Verifies a password against a hash
 * @param hashedPassword The stored hash in the format: iterations$salt$hash
 * @param plainPassword The plain text password to verify
 * @returns true if the password matches, false otherwise
 */
export async function verify(
  hashedPassword: string,
  plainPassword: string,
): Promise<boolean> {
  try {
    const parts = hashedPassword.split("$");
    if (parts.length !== 3) {
      return false;
    }

    const iterations = parseInt(parts[0], 10);
    const salt = base64ToArrayBuffer(parts[1]);
    const storedHash = base64ToArrayBuffer(parts[2]);

    // Derive key with the same parameters
    const derivedKey = await deriveKey(plainPassword, salt);
    const derivedKeyBytes = new Uint8Array(derivedKey);

    // Constant-time comparison to prevent timing attacks
    if (storedHash.length !== derivedKeyBytes.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < storedHash.length; i++) {
      result |= storedHash[i] ^ derivedKeyBytes[i];
    }

    return result === 0;
  } catch (error) {
    // If there's any error in parsing or verification, return false
    return false;
  }
}

/**
 * Configuration object for password requirements
 */
export const PASSWORD_CONFIG = {
  minLength: 8,
  maxLength: 128,
  iterations: ITERATIONS,
  keyLength: KEY_LENGTH,
  saltLength: SALT_LENGTH,
} as const;

/**
 * Validates password strength
 */
export function validatePasswordStrength(password: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (password.length < PASSWORD_CONFIG.minLength) {
    errors.push(
      `Password must be at least ${PASSWORD_CONFIG.minLength} characters long`,
    );
  }

  if (password.length > PASSWORD_CONFIG.maxLength) {
    errors.push(
      `Password must be at most ${PASSWORD_CONFIG.maxLength} characters long`,
    );
  }

  // Check for at least one letter and one number
  if (!/(?=.*[a-zA-Z])(?=.*\d)/.test(password)) {
    errors.push("Password must contain at least one letter and one number");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
