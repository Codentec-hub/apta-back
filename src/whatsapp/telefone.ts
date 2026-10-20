// Telefones de WhatsApp: guardados só com dígitos e DDI (5585912345678).
// O cadastro de contatos aceita qualquer formato, então a comparação usa
// uma "chave" (DDD + últimos 8 dígitos) que ignora DDI, máscara e o nono
// dígito — o WhatsApp às vezes entrega números de celular sem o 9.

export function normalizarTelefone(valor: string): string {
  const digitos = valor.replace(/\D/g, "").replace(/^0+/, "");
  // 10 ou 11 dígitos = DDD + número brasileiro sem DDI.
  if (digitos.length === 10 || digitos.length === 11) {
    return `55${digitos}`;
  }
  return digitos;
}

export function chaveTelefone(valor: string): string | null {
  let digitos = normalizarTelefone(valor);
  if (digitos.startsWith("55") && digitos.length >= 12) {
    digitos = digitos.slice(2);
  }
  if (digitos.length < 10) {
    return null;
  }
  return `${digitos.slice(0, 2)}${digitos.slice(-8)}`;
}

export function mesmoTelefone(a: string, b: string): boolean {
  const chaveA = chaveTelefone(a);
  return chaveA !== null && chaveA === chaveTelefone(b);
}

// Brasileiro com DDI + DDD (12 ou 13 dígitos) ou internacional plausível.
export function telefoneValido(valor: string): boolean {
  const digitos = normalizarTelefone(valor);
  if (digitos.startsWith("55")) {
    return digitos.length === 12 || digitos.length === 13;
  }
  return digitos.length >= 10 && digitos.length <= 15;
}
