{{/* vim: set filetype=mustache: */}}

{{- define "opsmind.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name. Component suffixes (-api, -postgresql, ...) are appended, so keep
headroom under the 63-char DNS label limit.
*/}}
{{- define "opsmind.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 50 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 50 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 50 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "opsmind.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels. Usage: include "opsmind.labels" (dict "ctx" $ "component" "api")
*/}}
{{- define "opsmind.labels" -}}
helm.sh/chart: {{ include "opsmind.chart" .ctx }}
{{ include "opsmind.selectorLabels" . }}
app.kubernetes.io/version: {{ .ctx.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
app.kubernetes.io/part-of: opsmind
{{- end }}

{{/*
Selector labels. Deployment/StatefulSet selectors are immutable, so these must never include
anything that changes between releases (version, chart).
*/}}
{{- define "opsmind.selectorLabels" -}}
app.kubernetes.io/name: {{ include "opsmind.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
{{- if .component }}
app.kubernetes.io/component: {{ .component }}
{{- end }}
{{- end }}

{{- define "opsmind.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "opsmind.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "opsmind.secretName" -}}
{{- default (include "opsmind.fullname" .) .Values.secrets.existingSecret }}
{{- end }}

{{- define "opsmind.configMapName" -}}
{{- include "opsmind.fullname" . }}
{{- end }}

{{/*
Image reference for an OpsMind component.
Usage: include "opsmind.image" (dict "ctx" $ "image" .Values.api.image)
*/}}
{{- define "opsmind.image" -}}
{{- $g := .ctx.Values.image -}}
{{- $tag := .image.tag | default $g.tag | default .ctx.Chart.AppVersion -}}
{{- if $g.registry -}}
{{- printf "%s/%s:%s" (trimSuffix "/" $g.registry) .image.repository (toString $tag) -}}
{{- else -}}
{{- printf "%s:%s" .image.repository (toString $tag) -}}
{{- end -}}
{{- end }}

{{- define "opsmind.imagePullPolicy" -}}
{{- .image.pullPolicy | default .ctx.Values.image.pullPolicy -}}
{{- end }}

{{- define "opsmind.postgresqlHost" -}}
{{- printf "%s-postgresql" (include "opsmind.fullname" .) }}
{{- end }}

{{- define "opsmind.redisUrl" -}}
{{- if .Values.redis.enabled }}
{{- printf "redis://%s-redis:6379" (include "opsmind.fullname" .) }}
{{- else }}
{{- required "externalRedis.url is required when redis.enabled=false" .Values.externalRedis.url }}
{{- end }}
{{- end }}

{{/*
Pod-level security context: chart-wide defaults merged with the component's numeric IDs.
Usage: include "opsmind.podSecurityContext" (dict "ctx" $ "component" .Values.api)
*/}}
{{- define "opsmind.podSecurityContext" -}}
{{- $sc := merge (deepCopy (.component.securityContext | default dict)) (deepCopy .ctx.Values.podSecurityContext) -}}
{{- toYaml $sc }}
{{- end }}

{{/*
Environment shared by the api, migration and worker containers. Secrets are referenced per key
(not envFrom) so each workload only receives the credentials it needs.
*/}}
{{- define "opsmind.nodeEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "opsmind.secretName" . }}
      key: DATABASE_URL
- name: JWT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "opsmind.secretName" . }}
      key: JWT_SECRET
- name: AI_SERVICE_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "opsmind.secretName" . }}
      key: AI_SERVICE_TOKEN
{{- end }}

{{/*
prometheus.io scrape annotations. Usage: include "opsmind.scrapeAnnotations" (dict "ctx" $ "port" 4000)
*/}}
{{- define "opsmind.scrapeAnnotations" -}}
{{- if .ctx.Values.metrics.podAnnotations }}
prometheus.io/scrape: "true"
prometheus.io/port: {{ .port | quote }}
prometheus.io/path: /metrics
{{- end }}
{{- end }}

{{/*
Checksums force a rollout when config or chart-managed credentials change.
*/}}
{{- define "opsmind.checksumAnnotations" -}}
checksum/config: {{ include (print .Template.BasePath "/configmap.yaml") . | sha256sum }}
{{- if not .Values.secrets.existingSecret }}
checksum/secret: {{ include (print .Template.BasePath "/secret.yaml") . | sha256sum }}
{{- end }}
{{- end }}
