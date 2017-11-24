package cool.graph.deploy.schema.types

import cool.graph.deploy.schema.SystemUserContext
import cool.graph.shared.models._
import sangria.schema
import sangria.schema.{Field, _}

import scala.reflect.ClassTag

object MigrationStepType {
  lazy val allTypes = List(
    Type,
    CreateModelType,
    DeleteModelType,
    UpdateModelType,
    CreateEnumType,
    DeleteEnumType,
    UpdateEnumType,
    CreateFieldType,
    UpdateFieldType,
    DeleteFieldType
  )

  lazy val Type: InterfaceType[SystemUserContext, MigrationStep] = InterfaceType(
    "MigrationStep",
    "This is a migration step.",
    fields[SystemUserContext, MigrationStep](
      Field("type", StringType, resolve = _.value.getClass.getSimpleName)
    )
  )

  lazy val CreateModelType = fieldsHelper[CreateModel](
    Field("name", StringType, resolve = _.value.name)
  )

  lazy val DeleteModelType = fieldsHelper[DeleteModel](
    Field("name", StringType, resolve = _.value.name)
  )

  lazy val UpdateModelType = fieldsHelper[UpdateModel](
    Field("name", StringType, resolve = _.value.name),
    Field("newName", StringType, resolve = _.value.newName)
  )

  lazy val CreateEnumType = fieldsHelper[CreateEnum](
    Field("name", StringType, resolve = _.value.name),
    Field("values", ListType(StringType), resolve = _.value.values)
  )

  lazy val DeleteEnumType = fieldsHelper[DeleteEnum](
    Field("name", StringType, resolve = _.value.name)
  )

  lazy val UpdateEnumType = fieldsHelper[UpdateEnum](
    Field("name", StringType, resolve = _.value.name),
    Field("newName", OptionType(StringType), resolve = _.value.newName),
    Field("values", OptionType(ListType(StringType)), resolve = _.value.values)
  )

  lazy val CreateFieldType = fieldsHelper[CreateField](
    Field("model", StringType, resolve = _.value.model),
    Field("name", StringType, resolve = _.value.name),
    Field("typeName", StringType, resolve = _.value.typeName),
    Field("isRequired", BooleanType, resolve = _.value.isRequired),
    Field("isList", BooleanType, resolve = _.value.isList),
    Field("isUnique", BooleanType, resolve = _.value.isUnique),
    Field("relation", OptionType(StringType), resolve = _.value.relation),
    Field("defaultValue", OptionType(StringType), resolve = _.value.defaultValue),
    Field("enum", OptionType(StringType), resolve = _.value.enum)
  )

  lazy val DeleteFieldType = fieldsHelper[DeleteField](
    Field("model", StringType, resolve = _.value.model),
    Field("name", StringType, resolve = _.value.name)
  )

  lazy val UpdateFieldType = fieldsHelper[UpdateField](
    Field("model", StringType, resolve = _.value.model),
    Field("name", StringType, resolve = _.value.name),
    Field("newName", OptionType(StringType), resolve = _.value.newName),
    Field("typeName", OptionType(StringType), resolve = _.value.typeName),
    Field("isRequired", OptionType(BooleanType), resolve = _.value.isRequired),
    Field("isList", OptionType(BooleanType), resolve = _.value.isList),
    Field("isUnique", OptionType(BooleanType), resolve = _.value.isUnique),
    Field("relation", OptionType(OptionType(StringType)), resolve = _.value.relation),
    Field("defaultValue", OptionType(OptionType(StringType)), resolve = _.value.defaultValue),
    Field("enum", OptionType(OptionType(StringType)), resolve = _.value.enum)
  )

  def fieldsHelper[T <: MigrationStep](fields: schema.Field[SystemUserContext, T]*)(implicit ct: ClassTag[T]) = {
    ObjectType(
      ct.runtimeClass.getSimpleName,
      "",
      interfaces[SystemUserContext, T](Type),
      fields.toList
    )
  }
}
