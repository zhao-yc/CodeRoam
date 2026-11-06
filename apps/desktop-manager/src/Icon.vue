<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 })

const paths: Record<string, string> = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  sliders: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 10h6 M9 8h6 M17 16h6',
  logs: 'M7 3h10l4 4v14H3V3z M7 11h10 M7 15h10 M7 7h5',
  info: 'M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  refresh: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8 M21 3v5h-5',
  power: 'M12 2v10 M6.3 5.3a9 9 0 1 0 11.4 0',
  play: 'M8 5v14l12-7z',
  pause: 'M9 5v14 M15 5v14',
  folder: 'M3 20h18V6H11L9 3H3z',
  chevron: 'm9 5 7 7-7 7',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  monitor: 'M3 3h18v13H3z M8 21h8 M12 16v5',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12 M6 18 18 6',
  shield: 'M12 2 3 6v6c0 6 9 10 9 10s9-4 9-10V6z m-4 10 3 3 5-5',
  clock: 'M12 7v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  signal: 'M4 20h.01 M4 14a6 6 0 0 1 6 6 M4 8a12 12 0 0 1 12 12 M4 2a18 18 0 0 1 18 18',
  alert: 'm12 3 10 18H2z M12 9v5 M12 17h.01',
}
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name] ?? paths.info" />
  </svg>
</template>
