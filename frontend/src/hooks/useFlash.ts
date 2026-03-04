import { useEffect, useRef, useState } from 'react';

export function useFlash(value: number): boolean {
  const [flash, setFlash] = useState(false);
  const prev = useRef(value);

  useEffect(() => {
    if (value !== prev.current) {
      prev.current = value;
      setFlash(true);
      const timeout = setTimeout(() => setFlash(false), 600);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [value]);

  return flash;
}

