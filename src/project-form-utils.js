const PROJECT_MACHINE_TAGS = {
  local: { className: 'tag-local', label: '本地电脑' },
  server: { className: 'tag-ssh', label: '服务器' },
};

export function normalizeProjectMachine(machine, serverId = '') {
  const normalizedMachine = Object.hasOwn(PROJECT_MACHINE_TAGS, machine) ? machine : '';
  return {
    machine: normalizedMachine,
    serverId: normalizedMachine === 'server' ? String(serverId || '') : '',
  };
}

export function projectMachineTag(machine) {
  return PROJECT_MACHINE_TAGS[machine] || null;
}
